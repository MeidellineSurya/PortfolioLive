# Decision Log

Organized per commit. Each entry documents meaningful or non-obvious technical
decisions made in that commit — not a changelog of what files were touched.

---

## Commit 1 — Backend models and portfolio store (Redis)

**Files:** `backend/models.py`, `backend/portfolio_store.py`, `backend/requirements.txt`

- **Ticker validation lives in the `Holding` model, not the route layer.**
  The spec requires "uppercase alpha only, max 5 chars" input validation.
  Putting it in a Pydantic `field_validator` means every code path that
  constructs a `Holding` (API route, Redis rehydration, tests) gets the same
  guarantee for free, instead of relying on each caller to remember to check.

- **`Holding.quantity` and `avg_cost` require `> 0`.** A zero or negative
  position isn't a valid holding to track P&L against; rejecting it early
  avoids division-by-zero / nonsensical P&L% downstream in the WebSocket
  manager.

- **Redis layout: one hash per ticker (`portfolio:{ticker}`) plus a
  side-set (`portfolio:tickers`).** A hash-per-ticker keeps `add`/`remove`
  atomic and cheap. The side-set avoids an `O(n)` `KEYS portfolio:*` scan
  (which blocks Redis and is unsafe in production) every time we need to
  enumerate holdings on startup or for `GET /portfolio`.

- **`add_holding`/`remove_holding` use a Redis pipeline with
  `transaction=True`.** Writing the hash and updating the ticker set are two
  separate commands; without a transaction a crash between them could leave
  the set and the hashes out of sync (e.g. a ticker in the set with no
  hash data, or vice versa).

- **`PortfolioStore` talks to `redis.asyncio`, not sync `redis`.** The whole
  backend is async (FastAPI + websockets), so a sync Redis client would block
  the event loop on every call.

- **`models.py` and `portfolio_store.py` come before any FastAPI/Alpaca code**
  per the specified implementation order — everything else (routes, the
  Alpaca client, the WS manager) depends on these shapes, so getting the
  data model right first avoids rework later.

---

## Commit 2 — Alpaca client (price streaming + news polling)

**Files:** `backend/alpaca_client.py`, `backend/requirements.txt`

- **The `StockDataStream` runs on a dedicated background thread via the
  SDK's blocking `stream.run()`, not as an `asyncio.create_task` on
  FastAPI's own loop.** This was verified against the installed `alpaca-py`
  0.43.5 source (`alpaca/data/live/websocket.py`), not assumed. The reason:
  `subscribe_quotes`/`unsubscribe_quotes`, when called *after* the stream is
  already connected, go through
  `asyncio.run_coroutine_threadsafe(coro, self._loop).result()` — a
  cross-thread handoff that **synchronously blocks the calling thread**
  until the target loop runs the coroutine. If the stream were driven on
  FastAPI's own loop, a later subscribe call made from a route handler
  (also on that loop) would block that same loop waiting for a callback
  that loop itself is supposed to run — a deadlock, not just a slow path.
  Running the stream on its own thread makes every subscribe/unsubscribe
  call genuinely cross-thread, which is what the SDK's locking actually
  expects. This is the single most important — and least obvious — decision
  in this file; get it wrong and adding a second ticker after the first
  price tick arrives hangs the server.

- **Quote callbacks hand off to the main event loop via
  `asyncio.run_coroutine_threadsafe(..., self._main_loop)` and don't wait on
  the result.** `_handle_quote` executes on the stream thread's own loop.
  The `on_quote` callback (owned by the WebSocket manager) needs to touch
  state that belongs to the main loop (broadcasting to connected clients).
  Scheduling it fire-and-forget, with a `add_done_callback` only for
  exception logging, keeps the stream thread free to keep consuming quotes
  instead of serializing on whatever the broadcast does.

- **Reconnection is a two-layer thing, and only the outer layer is ours.**
  The SDK's own `_run_forever` already retries on `WebSocketException` and
  generic exceptions indefinitely, but with **no backoff** — it retries via
  `await asyncio.sleep(0)`, so a persistent failure (e.g. bad credentials)
  would hot-loop against Alpaca's auth endpoint. `_run_stream_with_backoff`
  wraps `stream.run()` in an outer loop with exponential backoff
  (1s → 2s → 4s… capped at 30s, matching the frontend's reconnect scheme)
  so that if `stream.run()` ever *returns* — which only happens on a fatal
  `"insufficient subscription"` error or an explicit `.stop()` — we don't
  hammer the API on immediate retry. Each restart builds a fresh
  `StockDataStream` (a used instance's internal loop reference is spent)
  and resubscribes every ticker currently in `self._subscribed`.

- **`fetch_news` and `NewsClient.get_news` run through `asyncio.to_thread`.**
  `get_news` is a synchronous, blocking `requests`-based call in the SDK —
  awaiting it directly would stall the FastAPI event loop for the duration
  of the HTTP round trip.

- **Per-ticker "top 5" selection is deliberately *not* done here.** The spec
  places "fetch latest 5 news items per ticker" under `news_service.py`
  (commit 5), while `alpaca_client.py` only owns "poll every 60s via REST,
  filtered by symbols." `fetch_news` returns the raw batch (comma-joined
  symbol filter, `limit=50`, `exclude_contentless=True`); the news service
  will group by ticker and cap at 5 once it exists, keeping the REST-fetch
  and the summarisation/caching concerns in separate files as specified.

- **`AlpacaClient` is constructed on the main event loop and captures it
  (`asyncio.get_running_loop()`) in `__init__`.** This must happen during
  FastAPI startup (inside an async context), not at import time, since
  there's no running loop to capture otherwise — the loop reference is what
  lets stream-thread callbacks hand work back to the main thread.

- **`DataFeed.IEX` is passed explicitly to `StockDataStream`**, matching the
  spec's documented constraint (free tier, 15-minute delayed data, no live
  account needed) even though it's already the SDK's default — being
  explicit here means the free-tier assumption survives an SDK default
  changing under us.

- **Added a root `.gitignore`** (`__pycache__/`, `.venv/`, `.env`,
  `node_modules/`, `.next/`) now rather than later, since running the
  backend locally for the first time (to verify `alpaca_client.py` imports
  against the real SDK) immediately produced a stray `backend/__pycache__/`
  directory that would otherwise have been picked up by the next commit.

---

## Commit 3 — WebSocket manager (fan-out)

**Files:** `backend/websocket_manager.py`, `backend/alpaca_client.py` (added `get_previous_close`)

- **`change`/`change_pct` are computed against the previous trading day's
  close, fetched once per ticker via `AlpacaClient.get_previous_close`
  (a new method backed by `StockHistoricalDataClient.get_stock_snapshot`,
  reading `previous_daily_bar.close`) — not against "the first price seen
  this process." The spec's broadcast format includes `change`/`change_pct`
  but doesn't say what they're relative to; using the prior close matches
  how every retail portfolio UI defines "today's change" and avoids the
  alternative's obvious bug — a `change` of `0.0` on every ticker's first
  tick after a server restart, which would look broken.

- **This landed in commit 3, not commit 2, even though the code lives partly
  in `alpaca_client.py`.** `get_previous_close` only exists to serve the P&L
  calculation added here — it wasn't needed (or knowable as needed) until
  writing the broadcast logic surfaced the "relative to what?" question.
  Splitting it out into its own commit 2 addendum would've been a smaller
  diff but a less honest history of when and why the decision was made.

- **Previous close is cached in memory for the process lifetime, not
  refreshed at day rollover.** A full implementation would re-fetch at
  market open each day; that's real complexity (a scheduler, a definition
  of "market open" that accounts for holidays) that nothing in the spec
  asks for. Documented here as a known limitation rather than built
  speculatively — restarting the backend picks up the new day's previous
  close as a side effect of every ticker being re-subscribed from scratch
  on startup.

- **`position_pnl_pct` is relative to cost basis (`avg_cost * quantity`),
  not to `position_value`.** `position_pnl / cost_basis` is "return on what
  you paid," which is what "P&L %" conventionally means for a position;
  using `position_value` in the denominator would silently understate
  percentage gains (dividing by the already-inflated current value) and
  overstate percentage losses.

- **`broadcast` iterates a snapshot-safe pattern: send to every client
  inside the loop, collect failures into a `dead` list, then disconnect
  them after the loop.** Mutating `self._clients` (a `set`) while iterating
  it — e.g. calling `self.disconnect()` for a client whose `send_json`
  raised, from inside the same loop — would raise `RuntimeError: Set
  changed size during iteration`.

- **`on_quote` drops the tick (returns early) if the ticker isn't found in
  the portfolio store**, rather than broadcasting anyway. This handles the
  narrow race where a ticker was just removed via `DELETE /portfolio/{ticker}`
  but the Alpaca `unsubscribe_quotes` round trip (a cross-thread call, see
  commit 2) hasn't completed yet — an in-flight quote could otherwise arrive
  for a holding that no longer exists, and computing P&L against a
  nonexistent `avg_cost`/`quantity` doesn't mean anything.

- **`WebSocketManager` takes `AlpacaClient` and `PortfolioStore` as
  constructor arguments rather than constructing them itself.** Both are
  process-lifetime singletons that `main.py` (commit 4) will own and wire
  together at startup; keeping this class free of their construction
  details (API keys, Redis URL) keeps it testable in isolation.

---

## Commit 4 — FastAPI routes and WS endpoint

**Files:** `backend/main.py`, `backend/requirements.txt` (added `uvicorn`, `python-dotenv`)

- **"Rate limit the /portfolio/add endpoint (max 50 holdings)" is
  implemented as a holdings-count cap (`store.count_holdings() >= 50` →
  `429`), not a request-rate limiter (e.g. N requests/minute per IP).** The
  spec's own parenthetical — `(max 50 holdings)` — reads as a definition of
  what "rate limit" means here, not a separate requirement on top of one. A
  real per-IP throttle would need a new dependency (`slowapi` or similar)
  and a decision about IP-extraction behind Railway's proxy; the simpler
  reading avoids pulling that in for a requirement that's actually about
  bounding portfolio size, not request volume. If per-IP throttling turns
  out to be the intent, it's a small addition on top of this, not a
  redesign.

- **Singletons (`PortfolioStore`, `AlpacaClient`, `WebSocketManager`) are
  constructed inside the `lifespan` context manager and hung off
  `app.state`**, not module-level globals. `AlpacaClient.__init__` calls
  `asyncio.get_running_loop()` (commit 2) — that only works inside a
  running event loop, and `lifespan` is the first point in a FastAPI app's
  life where one is guaranteed to exist. Module-level construction would
  either crash on import or silently capture the wrong loop.

- **`on_quote` is a small closure passed into `AlpacaClient`, not
  `manager.on_quote` directly, because `manager` doesn't exist yet at the
  point `AlpacaClient` is constructed** (the manager's constructor takes
  the client as an argument). The closure defers the lookup of `manager`
  until it's actually called, sidestepping a chicken-and-egg construction
  order without restructuring either class.

- **`DELETE /portfolio/{ticker}` validates the path param against the same
  `TICKER_RE` used by the `Holding` model, and checks existence
  (`get_holding` → 404) before deleting.** Path params bypass Pydantic body
  validation entirely, so without this a malformed ticker (lowercase, too
  long, symbols) would reach `PortfolioStore.remove_holding` unchecked —
  harmless against Redis itself, but inconsistent with the "uppercase alpha
  only, max 5 chars" validation the `POST` path gets for free.

- **`POST /portfolio/add` is an upsert, not add-only.** `PortfolioStore.add_holding`
  is an `HSET`, which already overwrites; rejecting a duplicate ticker with
  a 409 would require an extra existence check for no real benefit — letting
  a user "add AAPL again" just update its quantity/avg_cost is the more
  useful behavior for a portfolio-management UI (re-adding after a
  cost-basis change, not just an error state to guard against).

- **CORS origin is read from a new `FRONTEND_ORIGIN` env var** (defaulting
  to `http://localhost:3000` for local dev), which isn't in the spec's
  listed backend env vars. "CORS configured for frontend origin only" isn't
  satisfiable with a hardcoded value once the frontend has a real Vercel
  URL, so this had to exist as *something* — called out explicitly here
  since it's an addition to the documented environment variable list, not
  because the decision itself is complex.

- **`load_dotenv()` runs at import time in `main.py`.** Railway/Vercel
  inject real environment variables directly (no `.env` file in
  production), so this only matters for local development — added
  `python-dotenv` to `requirements.txt` for that path, and it's a no-op
  when no `.env` file exists.

- **News polling is intentionally not wired up in this commit.**
  `main.py`'s lifespan starts the Alpaca price stream and loads existing
  holdings, but doesn't call `alpaca_client.start_news_polling(...)` yet —
  `news_service.py` (the thing that would actually consume the polled
  articles) doesn't exist until commit 5. Wiring a call to a service that
  isn't there yet would be dead/broken code sitting in the tree between
  commits.

- **Verification note:** confirmed `main.py` imports cleanly and all five
  routes (`/health`, `/portfolio`, `/portfolio/add`, `/portfolio/{ticker}`,
  `/ws`) register correctly against the real `fastapi`/`alpaca-py`
  packages in an isolated venv. Did *not* runtime-test the lifespan
  (Redis connect, Alpaca stream auth, a live WebSocket round trip) — no
  local Redis or Docker daemon was available in this environment, and real
  Alpaca/Groq credentials aren't in scope here. That end-to-end path still
  needs manual verification against real `.env` values before this is
  trusted in a deployed environment.

---

## Commit 5 — News service with Groq summarisation

**Files:** `backend/news_service.py`, `backend/alpaca_client.py` (`get_tickers` contract), `backend/main.py`, `backend/requirements.txt`

- **`AlpacaClient.start_news_polling`'s `get_tickers` callback became `async`
  (was a plain sync `Callable[[], list[str]]` in commit 2).** The real
  ticker source is `PortfolioStore.get_all_holdings`, which is inherently
  async (it's a Redis call). Commit 2 guessed at the shape of this callback
  before the real consumer existed; now that `news_service.py` is the thing
  actually supplying it, the honest fix is changing the contract, not
  wrapping an async store call in something sync. Verified against the
  installed SDK/venv that `main.py` still imports and all routes still
  register after the change.

- **Deduping *broadcasts* is a separate concern from caching *summaries*,
  and they use different storage with different lifetimes.** Alpaca's news
  REST endpoint has no "since" cursor — the same handful of recent articles
  reappear in every 60-second poll until they scroll out of the "latest N"
  window. Two caches handle two different problems:
  - `self._broadcast_ids` (in-process `set[int]`, unbounded for the
    process's lifetime) stops the same article being re-sent to already-
    connected clients on every poll cycle — without it, the news feed
    would just repeat itself every minute instead of showing new items.
  - The Redis-backed summary cache (5-minute TTL, per the spec) exists
    purely to avoid redundant Groq calls — e.g. the same article
    mentioning two held tickers, or a backend restart within the TTL
    window re-encountering an article whose in-memory dedup entry was lost.
  Conflating the two — e.g. using the Redis TTL cache alone to gate
  broadcasts — would either re-spam the feed every time the TTL expires
  (still within the article's "latest N" visibility window) or, if made
  permanent, would silently disable Groq calls forever for a given article
  even across intentional cache clears.

- **The Redis connection for summary caching is separate from
  `PortfolioStore`'s.** `PortfolioStore` never exposed its client, and
  news-summary caching isn't portfolio state — reusing it would mean either
  breaking that encapsulation or coupling two unrelated concerns to save
  one small connection pool. The cost (a second lightweight `redis.asyncio`
  pool) is worth keeping the modules independent.

- **A failed article (Groq error, network blip) is logged and skipped, not
  retried, and is *not* added to `_broadcast_ids`.** Since the same article
  will reappear in the next 60-second poll (no cursor, as above), simply
  not marking it as broadcast is the retry mechanism — no separate retry
  loop or backoff needed for this path.

- **`GROQ_MODEL = "llama-3.3-70b-versatile"`**, not `"llama-3.3-70b"` as
  written in the spec — verified against the installed `groq` 1.5.0 SDK's
  accepted model literals; Groq's actual model id for Llama 3.3 70B carries
  the `-versatile` suffix.

- **`groq==1.5.0`, pinned to the exact version whose API was inspected**
  (constructor signature, `chat.completions.create` params, response
  shape), same approach as `alpaca-py` in commit 2 — the goal is that
  every version pin in `requirements.txt` reflects a version this code was
  actually checked against, not a guess.

---

## Commit 6 — Frontend WebSocket hook

**Files:** `frontend/` (scaffolded), `frontend/lib/types.ts`, `frontend/lib/websocket.ts`, `frontend/.env.local.example`

- **Scaffolded with `create-next-app@15`, not `@latest`.** The first attempt
  used `@latest`, which resolved to Next.js 16.2.10 — `create-next-app`'s
  `@latest` tracks whatever's newest, and the spec asks for Next.js 15
  specifically. Deleted and re-ran pinned to `@15`, landing on 15.5.20
  (React 19.1.0). Worth noting because it would have been an easy thing to
  not double check — the package.json diff looks identical either way
  unless you read the version numbers.

- **Removed the default template's `public/*.svg` files** (Next/Vercel/file/
  globe/window icons) and will replace `app/page.tsx`'s starter content
  once the dashboard is actually assembled (commit 7+). Left as scaffolding
  cruft, they'd suggest unfinished work rather than an intentional stub.

- **WebSocket message types (`lib/types.ts`) use the backend's snake_case
  field names verbatim** (`avg_cost`, `position_pnl_pct`, etc.) instead of
  the camelCase that's conventional in TypeScript. The backend's
  `model_dump()` (commit 1) has no alias config, so the wire format is
  already snake_case; adding a mapping layer to convert it would be a
  translation step that exists purely for naming-convention purity, with a
  real cost (one more place a field can be renamed on one side and missed
  on the other) and no functional benefit.

- **`useWebSocket`'s reconnect backoff is tracked in a `ref`, not `state`.**
  The delay value needs to survive across `onclose` handler closures and
  double between attempts, but changing it should never itself trigger a
  re-render — using `useState` for it would cause an extra render on every
  reconnect attempt for no reason. `readyState` and `lastMessage` *are*
  state, since the UI needs to re-render when they change.

- **A `boolean` ref (`unmountedRef`), not a check on `reconnectTimeoutRef`,
  distinguishes "cleanup closed this" from "the server dropped us."**
  Without it, the cleanup function's `wsRef.current?.close()` call would
  itself fire `onclose`, which would then schedule a reconnect *after* the
  component already unmounted (or after the `url` dependency changed and
  a new effect run already started a fresh connection) — a leaked timer
  and, in the url-change case, two competing WebSocket connections.

- **`onerror` closes the socket and lets `onclose` own all reconnect
  scheduling, rather than scheduling a reconnect from both handlers.** The
  browser WebSocket spec guarantees `close` fires after `error`; scheduling
  from both would double the reconnect attempt (and double-apply the
  backoff multiplier) on every network-level failure.

- **Verification:** `npx tsc --noEmit` and `npx eslint` both pass clean on
  the new files. Did not yet run the dev server / exercise this in a
  browser — there's no page wired up to actually open a connection until
  the dashboard (`page.tsx`) is assembled in the next few commits; testing
  this hook in isolation against a running backend happens once there's a
  UI to watch it in.

- **Patched `create-next-app`'s generated `frontend/.gitignore`**: its
  default `.env*` pattern silently swallowed `.env.local.example` too (it's
  a glob, not an exact match on `.env`/`.env.local`), which would have
  meant the example file — added specifically so a new developer knows what
  env vars to set — never actually made it into git. Added a `!.env*.example`
  negation line. Caught by checking `git status` after staging rather than
  assuming `git add` picked up everything intended.

---

## Commit 7 — Portfolio table with live updates

**Files:** `frontend/app/page.tsx`, `frontend/app/components/PortfolioTable.tsx`, `frontend/lib/types.ts` (`PortfolioRow`), `frontend/lib/format.ts` (new), `frontend/app/layout.tsx` (metadata)

- **Added `lib/format.ts`, which isn't in the spec's listed file structure.**
  `formatCurrency`/`formatPercent`/`formatSignedCurrency` are needed by
  `PortfolioTable` now and will be needed by `NewsFeed`'s relative-timestamp
  formatting in commit 8 — putting them in one shared file avoids the same
  `Intl.NumberFormat` setup (and the "is this positive number supposed to
  get a `+` sign" logic) being duplicated and potentially drifting between
  components. Small, deliberate deviation from the literal file list, not
  an unplanned addition.

- **`PortfolioRow` (in `lib/types.ts`) is `Holding & Partial<Omit<PriceUpdate, "type" | "ticker">>`**
  — a holding merged with whatever live fields have arrived for it, all
  optional. A row exists in the table the moment `GET /portfolio` resolves,
  but its price/P&L fields don't exist until the first `price_update` tick
  for that ticker arrives over the WebSocket; making them optional (rather
  than, say, defaulting price to `0`) lets the table render an explicit
  "—" placeholder instead of a misleading `$0.00`/`0.00%` that looks like a
  real (and alarming) loss.

- **The portfolio `useReducer` only handles `SET_HOLDINGS`, `REMOVE_HOLDING`,
  and `PRICE_UPDATE` in this commit — no `ADD_HOLDING` action yet.**
  Optimistic add (spec: "On submit: POST to /portfolio/add, optimistically
  add to UI") belongs to `AddTickerForm`, which is commit 9. Adding the
  action now with nothing to dispatch it would be dead code sitting in the
  reducer.

- **News state is deliberately *not* wired up here, even though `lastMessage`
  already carries `news_update` messages too.** The spec calls out
  `useReducer` specifically for portfolio state; news is a simple
  prepend-and-cap-at-20 operation that doesn't need reducer machinery.
  Handling both message types in this commit would tangle two components'
  concerns together — the right column renders a "Coming soon" placeholder
  until `NewsFeed` (commit 8) replaces it with the real thing and its own
  message handling.

- **`REMOVE_HOLDING` is optimistic**: the reducer removes the row
  immediately, then `DELETE /portfolio/{ticker}` fires without blocking the
  UI on its result. A failed delete isn't specially handled — the row would
  simply reappear on the next full `/portfolio` refetch (there isn't one on
  a timer yet, so today a failed delete's row silently doesn't come back;
  acceptable for now since the spec doesn't ask for a reconciliation
  mechanism, but worth knowing if delete reliability becomes a problem).

- **`PRICE_UPDATE` drops ticks for tickers no longer in `state`.** This
  mirrors `WebSocketManager.on_quote`'s identical guard on the backend
  (commit 3) for the same reason: a quote can arrive for a ticker between
  its removal and the backend's unsubscribe taking effect. Keeping both
  sides defensive means neither has to assume the other's race window is
  fully closed.

- **Removed the `create-next-app` starter markup from `app/page.tsx`
  entirely** (the Next.js logo, "Deploy now" / "Read our docs" links,
  footer) rather than leaving it commented out or partially replaced —
  none of it does anything useful once real content exists, and dead
  starter markup left in place tends to look like an oversight rather than
  an intentional stub.

- **Verification:** `npx tsc --noEmit` and `npx eslint` pass clean. Ran
  `npm run dev` and confirmed via `curl` that the server-rendered HTML
  contains the expected structure (title, Total Value/P&L labels, the
  "No holdings yet" empty state, both column headers) with a clean `200`
  and no compile/runtime errors in the dev server log. No backend was
  running, so this only exercises the empty-portfolio / WebSocket-still-
  connecting path — the live-update path (a real `price_update` tick
  actually repainting a row) will get exercised once there's a way to add
  a holding (commit 9) and a backend running against real Alpaca
  credentials. Also could not visually screenshot the page — no headless
  browser tool was available in this environment — so light/dark styling
  and exact layout were verified by reading the rendered HTML/Tailwind
  classes, not by eye.

---

## Commit 7a — Fixes found running the backend live end-to-end

**Files:** `backend/main.py`, `backend/alpaca_client.py`

Running the backend against real Redis, Alpaca, and Groq credentials (at
the user's request, to test the frontend against live data) surfaced three
real problems that no amount of import-checking or isolated unit-level
testing had caught. Recorded here as their own commit since they're bug
fixes discovered through live verification, not part of the Step 7
frontend work.

- **`DELETE /portfolio/{ticker}` crashed the app at import time.**
  `async def remove_holding(ticker: str) -> None:` combined with
  `status_code=204` trips a real FastAPI assertion
  (`AssertionError: Status code 204 must not have a response body`),
  because FastAPI infers `response_model` from a bare `-> None` return
  annotation as "the response model is `NoneType`" — a real Pydantic model
  it tries to validate against — which is a different thing from "there is
  no response model," and 204 requires the latter. Every earlier `import
  main` smoke check (commits 4, 5) used an ad-hoc scratch venv with
  whatever `fastapi` version `pip install fastapi` resolved to that day;
  the actual pinned `fastapi==0.115.4` from `requirements.txt` hit this
  assertion the first time the app was run for real. Fixed by passing
  `response_model=None` explicitly in the decorator. **Lesson applied
  here:** version-pinned smoke tests aren't the same as running the pinned
  versions — worth remembering for future backend changes.

- **An unhandled exception in the news-polling loop could kill it forever,
  silently.** In `AlpacaClient._poll_news_forever`, the `try/except` only
  wrapped `fetch_news`/`on_batch`, not `await get_tickers()`. If that call
  ever raised, the coroutine backing `self._news_task` would die — and
  because `self._news_task` holds a permanent strong reference to the
  `Task`, Python's "exception was never retrieved" warning (which only
  fires on garbage collection) would never surface either. The failure
  mode is a background task that's dead but shows zero evidence of it: no
  crash, no log line, nothing — indistinguishable from "just hasn't found
  anything to broadcast yet" from the outside. This is exactly what made it
  hard to diagnose live: everything *looked* like a working-but-quiet app
  for several minutes before isolated reproduction of `fetch_news` and
  `NewsService._handle_batch` (both worked perfectly standalone) narrowed
  it down to something specific to the long-running task's error handling.
  Fixed by wrapping the entire loop body in the `try/except`, so any
  failure is logged and the loop keeps running on the next 60s tick.

- **`main.py`'s `lifespan` didn't guarantee `alpaca_client.stop()` runs if
  startup fails between `alpaca_client.start()` and `yield`.** Directly
  observed this live: an earlier test run failed at
  `manager.load_initial_holdings()` (Redis was down at that moment), which
  happens *after* `alpaca_client.start()` already opened a real Alpaca
  stream connection on a daemon thread. Because the exception happened
  before `yield`, the shutdown code after it — including
  `alpaca_client.stop()` — never ran; uvicorn just aborted startup, and the
  daemon thread died with the process without a clean WebSocket close.
  Alpaca allows exactly one active stream connection per account, and the
  next several backend restarts all failed with `"connection limit
  exceeded"` until whatever server-side detection Alpaca uses eventually
  timed out the orphaned connection — several minutes of being locked out
  of testing entirely. Fixed by wrapping `load_initial_holdings()` /
  `news_service.start()` / `yield` in a `try/finally` so cleanup always
  runs once the stream has been started, regardless of what fails after.

- **Added `logging.basicConfig(...)` in `main.py`.** There was no logging
  configuration anywhere in the app. With no handler attached anywhere in
  the logger hierarchy, Python's default behavior only prints WARNING+ via
  its "handler of last resort," and even that has no timestamps or module
  names — every `logger.info` call already written across `alpaca_client.py`,
  `websocket_manager.py`, and `news_service.py` (e.g. "starting Alpaca
  price stream") was completely invisible. This isn't just a debugging
  convenience: a background process managing a persistent WebSocket
  connection and a 60-second poll loop needs to be observable from its
  logs alone once it's actually running unattended (Railway, commit 11)
  — silence on stdout shouldn't be the only signal available for "is this
  working."

- **Added a temporary-turned-permanent pair of INFO logs in
  `_poll_news_forever`** (ticker count and fetched-article count per
  cycle). Added specifically to diagnose the exception-swallowing bug
  above, but kept: knowing "the loop is alive and ran with N tickers" is
  exactly the operational signal that was missing when this was hardest to
  debug.

- **Live verification performed, credentials courtesy of the user testing
  locally:** real Alpaca REST snapshot/news calls, a real Alpaca IEX quote
  stream connection (`subscribed to quotes: ['AAPL']`), five real Groq
  chat-completion calls producing correctly-formatted one-sentence
  summaries, Redis caching (`news_summary:{id}` keys with real TTLs), the
  in-memory broadcast-dedup logic (three subsequent 60s poll cycles each
  refetched the same 50 articles and correctly made zero new Groq calls),
  and a real `/ws` client connection via a throwaway Python script. Not
  verified live: an actual `price_update` broadcast (Alpaca's market was
  closed for the session during testing, so no quote ticks arrived) — the
  P&L computation in `websocket_manager.py` remains verified by reading,
  not by observing a real tick flow through it end-to-end.

---

## Commit 7b — GitHub Actions CI (lint + tests on PR)

**Files:** `.github/workflows/ci.yml`, `backend/pyproject.toml`, `backend/requirements-dev.txt`, `backend/tests/test_models.py`

- **Backend "tests" needed something real to run.** There were zero test
  files anywhere in the repo before this. A CI step that runs `pytest`
  against an empty `tests/` directory exits non-zero ("no tests ran"),
  which would make the workflow permanently red for a reason that has
  nothing to do with code quality. Added `tests/test_models.py` covering
  `Holding`'s validation logic (ticker normalization, the uppercase/length
  regex, the `quantity`/`avg_cost` positivity constraints) — genuine tests
  of real logic, not placeholders, and the one piece of backend code with
  actual branching to verify without needing Redis/Alpaca/Groq.
  Deliberately did **not** add integration tests (a live Redis service
  container, mocked Alpaca/Groq clients) — that's a meaningfully bigger
  scope than "add a CI workflow," and the user can ask for it separately
  if wanted.

- **`ruff` chosen for backend linting**, not `flake8`+`isort`+`black`
  separately — one tool, one config block, covers the same ground
  (pycodestyle/pyflakes rules `E`/`F` plus import sorting `I`) with a much
  faster CI step.

- **`line-length = 110`, not ruff's default 88.** Ran `ruff check .`
  against the existing, already-reviewed backend before adding any config
  — the only findings were 12 line-length violations (all in the 89–110
  char range) and one import-sort fix, zero actual bugs (no unused
  imports, no undefined names). Reformatting a dozen already-correct lines
  purely to satisfy a default nobody had targeted while writing them would
  be pure churn; raising the limit to match the codebase's actual style
  (verified: nothing exceeds 110) was the smaller, more honest diff. The
  one auto-fixable import-sort finding (`main.py`'s `from models import
  Holding, TICKER_RE` → alphabetized to `TICKER_RE, Holding`) was applied
  via `ruff check --fix` and folded into commit 7a's `main.py` changes
  rather than given its own commit, since it's a one-line cosmetic
  reorder with no behavior change.

- **`backend/requirements-dev.txt` is separate from `requirements.txt`**,
  not merged into it. `ruff`/`pytest` have no reason to be installed in
  the Railway production container (commit 11) — keeping them dev-only
  keeps the production image smaller and makes it obvious which
  dependencies are "needed to run this" vs. "needed to work on this."

- **`pythonpath = ["."]` in `backend/pyproject.toml`'s pytest config**,
  rather than relying on `python -m pytest`'s cwd-insertion behavior or
  adding `tests/__init__.py`. The backend has no package structure (no
  `src/` layout, `models.py` etc. live directly in `backend/`), so pytest's
  default import mode wouldn't put `backend/` on `sys.path` when
  discovering `backend/tests/test_models.py`, and `from models import
  Holding` would fail. Explicit `pythonpath` works regardless of how
  pytest is invoked (bare `pytest`, `python -m pytest`, from CI or
  locally) rather than depending on invocation-specific behavor.

- **Frontend CI pins Node 22, not Node 20** (what's actually installed in
  this dev environment, 20.12.1). `npm install` here has been emitting an
  `EBADENGINE` warning the whole time because `eslint-visitor-keys`
  requires `^20.19 || ^22.13 || >=24` — 20.12.1 doesn't satisfy that range.
  It's non-fatal locally, but there's no reason to bake a known engine
  mismatch into CI when picking a different LTS avoids it entirely.

- **Frontend job runs lint, `tsc --noEmit`, and `next build` as three
  separate steps**, not just `next build` alone (which does run type
  checking as part of its pipeline). Splitting them means a PR that fails
  linting shows "Lint" red rather than a generic "Build" failure — the
  step name is the first thing a diagnosis starts from.

- **Verification:** ran the exact CI commands locally before writing the
  workflow, not after — `ruff check .` and `pytest` both pass clean in the
  backend venv (7 tests), and `npm run lint`, `npx tsc --noEmit`, and
  `npm run build` all pass clean in the frontend (production build
  succeeds, 2 static routes generated). The workflow file itself is
  untested against real GitHub Actions (no push to a remote yet) — the
  commands it runs are verified, but the YAML syntax and trigger
  configuration are not.

---

## Commit 8 — News feed component

**Files:** `frontend/app/components/NewsFeed.tsx`, `frontend/app/page.tsx`, `frontend/lib/format.ts` (`formatRelativeTime`)

- **News state uses `useState`, not `useReducer`, as flagged as the plan
  back in commit 7's log.** The only operation is "prepend one item, cap at
  20" (`[lastMessage, ...prev].slice(0, MAX_NEWS_ITEMS)`) — a single state
  transition, not several action types coordinating shared state the way
  the portfolio reducer does. Confirming that call now that it's actually
  implemented: a reducer here would be a wrapper around one line with no
  organizational benefit.

- **The WS message effect now branches on `lastMessage.type`** to route
  `price_update` to the portfolio reducer and `news_update` to the news
  `setState`, replacing the price-only check from commit 7. Both message
  types share the same `lastMessage` value from `useWebSocket` (there's
  only one), so this dispatch point was always going to need to exist
  somewhere — putting it here, right where the message arrives, keeps
  `NewsFeed` and `PortfolioTable` themselves free of any WebSocket
  awareness; they just render whatever props they're given.

- **List key is `${item.ticker}-${item.url}`, not `item.url` alone.** The
  backend broadcasts one `news_update` per (ticker, article) pair
  (`news_service.py`, commit 5) — an article mentioning both AAPL and MSFT
  produces two separate messages with the same `url` but different
  `ticker`. Using `url` alone as the key would collide and make React
  drop one of the two entries.

- **Headline links out (`target="_blank"`) using the AI summary as the
  link text, not the raw headline.** Per spec: "Show AI summary
  prominently, headline below in muted text." The summary is the thing
  users actually read; making it the clickable element (rather than a
  separate "read more" link) means clicking the most-read line of text is
  what people would try first anyway.

- **`formatRelativeTime` buckets to minutes/hours/days** (`"3 min ago"`,
  `"2h ago"`, `"1d ago"`) rather than using `Intl.RelativeTimeFormat`.
  The built-in formatter needs to be told which unit to use — you can't
  hand it a raw millisecond delta and get "the right" granularity back —
  so using it directly would need close to the same bucketing logic this
  already has, just to feed it the right unit. Not worth pulling in a second
  approach for the same amount of code.

- **Verification:** `npx tsc --noEmit` and `npx eslint` clean on the new
  and changed files. `npm run build` still succeeds (production build,
  same 2 static routes). Started the dev server fresh and confirmed via
  `curl` that the server-rendered HTML includes the new empty-state copy
  ("No news yet — items appear here..."). As with commit 7: no backend was
  connected during this particular check and no headless browser was
  available, so the actual live path — a real `news_update` frame arriving
  over the WebSocket and `NewsFeed` re-rendering with a real item — was not
  visually observed in a browser. It was, however, indirectly exercised:
  the backend's live-testing session (commit 7a) confirmed real
  `news_update` messages broadcast correctly over `/ws` with the exact
  shape `NewsFeed` expects, via a raw WebSocket test script rather than
  this UI.

---

## Commit 9 — Add ticker form (remove was already commit 7)

**Files:** `frontend/app/components/AddTickerForm.tsx`, `frontend/app/page.tsx`

- **"Add/remove ticker form" in the implementation order turned out to be
  mostly already done.** The spec's per-component breakdown puts "Remove
  button per row" under `PortfolioTable.tsx`, not `AddTickerForm.tsx` — so
  remove was implemented back in commit 7 alongside the table. This commit
  is really just "add," despite the step's name in the implementation
  order.

- **Client-side ticker validation duplicates `TICKER_RE` from
  `backend/models.py`** (`^[A-Z]{1,5}$`) rather than only relying on the
  backend's rejection. A round trip to find out "AAPL2" is invalid is a
  worse experience than an inline message on submit — this is UX,
  not a substitute for the backend's validation, which still runs
  regardless of what the client checked.

- **`onAdd` is optimistic and rolls back on failure, unlike `onRemove`
  (commit 7), which doesn't.** The two failure modes aren't symmetric: a
  failed `DELETE` just means an already-gone-from-the-UI row silently
  comes back on the next refetch — mildly stale, self-correcting. A failed
  `POST` that isn't rolled back leaves a row that will *never* receive a
  price tick (the backend never subscribed it to anything), permanently
  stuck at the "—" placeholders from commit 7 — indistinguishable from
  "this ticker just doesn't have data yet" to the user, with no future
  event that would ever fix it. That asymmetry is why `handleAdd` rolls
  back explicitly (dispatches `REMOVE_HOLDING` for the just-added ticker)
  on a non-OK response or a network failure, while `handleRemove` doesn't
  bother.

- **`ADD_HOLDING` in the portfolio reducer is an upsert** (`{ ...existing,
  ...action.holding }`), deliberately matching `POST /portfolio/add`'s own
  upsert semantics documented in commit 4 — re-adding a ticker already in
  the table updates its quantity/avg cost in place rather than needing
  special-case handling for "this ticker already exists."

- **Verification — this time against the real backend, not just SSR
  structure:** started the backend (real Redis/Alpaca/Groq, same setup as
  commit 7a) and the frontend together, pointed at each other via a
  temporary `.env.local`. Confirmed `GET /portfolio` still returned the
  `AAPL` holding surviving from earlier live testing. Sent the *exact*
  request shape `AddTickerForm`'s `onAdd` produces
  (`POST /portfolio/add` with `{ticker, quantity, avg_cost}`) directly via
  `curl` for a new ticker (`MSFT`) — got `201`, confirmed it appeared in a
  follow-up `GET /portfolio`, then `DELETE`d it to leave the portfolio
  clean. `tsc`/`eslint` clean, production build still succeeds. Not
  verified: the actual optimistic-then-rollback UI transition and the
  client-side validation error message rendering — both are plain React
  state changes with no complex logic, but "renders correctly in a
  browser" specifically still wasn't observed, for the same
  no-headless-browser reason as commits 7 and 8.

---

## Commit 10 — Sparkline charts

**Files:** `frontend/app/components/PriceSparkline.tsx`, `frontend/app/components/PortfolioTable.tsx`, `frontend/app/page.tsx`, `frontend/lib/types.ts`

- **Price history lives in `PortfolioRow.priceHistory`, appended in the
  `PRICE_UPDATE` reducer case, capped at 20 with `.slice(-20)`.** This is
  client-only derived state with no backend equivalent — `PriceUpdate`
  only ever carries the single latest price (`websocket_manager.py`,
  commit 3), so "last 20 points" has to be accumulated client-side, tick
  by tick, from the moment each ticker starts receiving updates. A
  practical consequence worth knowing: the sparkline only reflects prices
  seen *since this browser tab connected* — reloading the page empties
  `priceHistory` back to zero and it rebuilds from scratch, even though
  the ticker itself may have been tracked for hours. Fetching historical
  bars from Alpaca to pre-seed the chart on load would fix that, but nothing
  in the spec asks for it and it's a distinct feature, not a sparkline
  detail.

- **The sparkline's color reflects the trend *within its own 20-tick
  window* (last price vs. first price currently visible), not the
  position's overall P&L sign.** These can legitimately disagree — a
  holding purchased at a loss can be ticking upward right now, or vice
  versa. Reusing the P&L column's green/red logic for the sparkline would
  conflate "how is this position doing overall" with "what's this price
  doing right now," which are different questions the two UI elements are
  each supposed to answer on their own.

- **Added as a new "Trend" column between "Current Price" and "Value"**,
  not appended at the end after "P&L (%)". The spec's column list doesn't
  mention it at all (sparklines are described separately, under
  `PortfolioTable.tsx`'s bullet points, not in the "Columns:" line) — placed
  next to the price it's charting rather than after the P&L columns, since
  it's visually a detail *of* the price, not a summary metric like the
  columns that follow it.

- **`PriceSparkline` renders an em dash placeholder below 2 data points**,
  matching every other "no data yet" cell in `PortfolioTable` (commit 7).
  A `LineChart` with 0 or 1 points is either empty or a single dot — neither
  reads as "chart," so treating "not enough data" as its own explicit state
  (rather than rendering a degenerate/empty chart) keeps it visually
  consistent with the rest of the row.

- **Bundle size impact, noted rather than addressed:** the page route's
  First Load JS grew from ~3 kB to ~92 kB after adding `recharts` imports
  (confirmed via `next build` output). Recharts is what the spec
  specifies, and a mini sparkline doesn't justify hunting for a lighter
  charting library — but it's the single biggest jump in bundle size of
  any commit so far, worth knowing about if load time becomes a concern
  later.

- **Verification:** `npx tsc --noEmit` and `npx eslint` clean.
  `npm run build` succeeds with `recharts` bundled — this specifically
  checks that `ResponsiveContainer` (which measures DOM dimensions) doesn't
  break Next's server-side rendering pass, since that class of
  measurement-dependent component is a common source of SSR crashes in
  React charting libraries. Started the real backend + frontend together
  again (same setup as commit 9) and confirmed no compile or runtime
  errors in either server's logs. Did not visually confirm an actual
  rendered sparkline with real price ticks flowing through it — the
  market was closed for every live-testing session in this project so
  far, so `priceHistory` never accumulated enough real points to plot;
  what's verified is that the component handles zero/one-point input
  correctly (renders the placeholder) and that the two-or-more-point
  rendering path type-checks and builds, not that it looks right on
  screen with real data.

---

## Commit 11 — Docker + Railway deployment config

**Files:** `backend/Dockerfile`, `backend/.dockerignore`, `backend/railway.toml`

- **`CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}` — the
  `exec` is load-bearing, not stylistic, and this was verified empirically,
  not assumed.** Railway assigns the listen port at runtime via `$PORT`,
  which rules out JSON-array `CMD` (no shell, no variable expansion — the
  literal string `"$PORT"` would get passed to uvicorn). But shell-form
  `CMD` on its own runs `/bin/sh -c "..."` as PID 1 with uvicorn as its
  *child*; Docker's `stop` sends `SIGTERM` to PID 1, and a plain shell
  isn't guaranteed to forward it to the child. That matters concretely
  here: `main.py`'s lifespan `try/finally` (commit 7a) only closes the
  Alpaca stream connection on a clean shutdown — if `SIGTERM` never
  reaches uvicorn, Railway's container just hangs until Docker's
  `SIGKILL` timeout, and the exact connection-leak problem commit 7a fixed
  comes back on every redeploy. `exec` in a shell-form `CMD` replaces the
  shell process image with the command itself (standard POSIX behavior),
  so uvicorn ends up *as* PID 1 and receives signals directly.
  Built the image, ran it, and confirmed via `docker top` that the
  container's PID 1 is the `uvicorn` process itself (not `/bin/sh`), and
  timed `docker stop`: 0.39s, vs. what would be a ~10s hang to the default
  `SIGKILL` timeout if the signal weren't reaching the app. Also confirmed
  a non-default `PORT` env var (`9000`) is correctly picked up and bound.
  Note: an earlier test *without* `exec` also stopped quickly (1.2s) —
  turned out `/bin/sh -c` applies its own tail-call optimization and
  exec's automatically when the command string is a single simple command
  with nothing else to do afterward, which happened to be true here. Kept
  the explicit `exec` anyway rather than relying on that implementation
  detail: it's shell-version-dependent, silently breaks if `CMD` ever
  grows a second statement (e.g. `&& echo done`), and is what actually
  addresses Docker's own `JSONArgsRecommended` lint warning rather than
  coincidentally satisfying it.

- **Runs as a non-root `appuser`**, created and `chown`'d in the same
  `RUN` layer right before `USER appuser`. Standard container hardening —
  no process in this app needs root (no privileged ports, no system
  package installs at runtime).

- **`requirements.txt` is `COPY`'d and installed in its own layer before
  `COPY . .`**, so `docker build` only re-runs `pip install` (the slow
  step — `alpaca-py`, `pandas`, `pydantic-core` all have real wheels to
  fetch) when dependencies actually change, not on every source edit.
  Standard layer-caching order, but worth stating since it's the reason
  the two `COPY` lines aren't merged into one.

- **`.dockerignore` excludes `tests/`, `.venv/`, `.env`, and
  `requirements-dev.txt`** — none of `ruff`/`pytest`/the local venv/dev
  secrets belong in a production image. Mirrors the `requirements.txt` vs
  `requirements-dev.txt` split from commit 7b: dev-only tooling doesn't
  ship.

- **`railway.toml` sets `healthcheckPath = "/health"`**, pointing at the
  endpoint added all the way back in commit 4. Railway won't route traffic
  to a new deploy until its health check passes, which — combined with
  `restartPolicyType = "ON_FAILURE"` — means a deploy that can't reach
  Redis or has bad Alpaca/Groq credentials fails the health check and gets
  rolled back automatically, rather than serving broken traffic.

- **No `frontend/Dockerfile`.** The spec's own architecture line is
  explicit: "Deploy: Railway (backend), Vercel (frontend)." Vercel builds
  Next.js apps natively from the repo (its own build pipeline, not a
  Dockerfile) — adding one would be unused configuration for a deploy
  target that was never going to read it.

- **Verification, all done against the real Docker daemon, not just
  `Dockerfile` syntax review:** `docker build` succeeds (all 34 backend
  dependencies install cleanly on `python:3.12-slim`, including compiled
  ones — `pydantic-core`, `numpy`, `pandas` — via prebuilt wheels, no
  `build-essential` needed). Ran the built image standalone against an
  isolated, empty Redis container (deliberately not the one with leftover
  `AAPL` test data from earlier sessions, to keep this a clean "container
  boots with no external state" check) and confirmed `GET /health` returns
  `200`. `railway.toml` parsed successfully with Python's `tomllib` to
  catch any TOML syntax error before it'd surface as a Railway deploy
  failure. All test containers and the test image were removed after
  verification — nothing left running.

---

## Commit 12 — "Load more" news endpoint (backend)

**Files:** `backend/main.py`, `backend/news_service.py`, `backend/alpaca_client.py`

User-requested feature, discovered live while testing: the news feed only
ever shows the 5 articles per ticker that the 60s poll cycle already
broadcast (`NEWS_ITEMS_PER_TICKER`, commit 5) — there was no way to see
anything older on demand.

- **Alpaca's `end` filter on the news endpoint is inclusive — verified
  live against the real API, not assumed.** Fetched 3 articles, took the
  oldest one's exact `created_at`, passed it back as `end` on a follow-up
  request: the same article came back again as the first result. This
  matters directly for pagination: naively passing "the oldest article
  currently shown" as the cursor for "give me older ones" would return
  that same article as a duplicate on every "load more" click.

- **Fixed by reusing `_broadcast_ids` (commit 8's dedup set) rather than
  fudging the timestamp (e.g. subtracting a second).** A timestamp
  epsilon depends on Alpaca's actual timestamp precision, which isn't
  documented and isn't worth relying on. Instead, `get_more_news`
  over-fetches (`limit * 3`) with the inclusive `end`, then filters out
  anything whose id is already in `_broadcast_ids` before taking the
  first `limit` — the same mechanism that already stops the 60s poll from
  re-broadcasting an article gets reused here for an on-demand fetch,
  rather than inventing a second, timestamp-based dedup strategy. Verified
  live across two sequential "load more" calls: the boundary article from
  the first page did not reappear in the second.

- **Articles returned by "load more" get added to `_broadcast_ids`
  immediately**, not left for the next poll cycle to (maybe) pick up.
  Without this, the very next 60s poll could re-broadcast an article the
  user just explicitly paged to, appearing as a confusing duplicate back
  at the *top* of the live feed a few seconds after they saw it at the
  bottom.

- **`GET /news/{ticker}` is a plain request/response, not something that
  goes through `WebSocketManager.broadcast`.** This is one client asking
  for more of *their own* view's history — pushing it to every connected
  client the way live news updates work would mean everyone's feed
  jumping around because one person clicked "load more" on a ticker they
  might not even be looking at.

- **No unit test added for `get_more_news`.** It's tightly coupled to
  three external services (Alpaca REST, Groq, Redis) — testing it
  meaningfully would mean mocking all three, which is real scope beyond
  what a quick feature addition warrants. Verified live instead (see
  above): real API calls, real pagination behavior, real dedup
  correctness. Same call made in commit 7b about integration tests
  applies here.

---

## Commit 13 — News tabs + load-more UI (frontend)

**Files:** `frontend/app/components/NewsFeed.tsx`, `frontend/app/page.tsx`

- **The "All" tab's sentinel value is `null`, not the string `"ALL"`.**
  Checked before writing this: Allstate Corporation's real ticker symbol
  is `ALL`. A user holding Allstate stock would have a tab literally
  labeled "ALL" sitting next to the meta-tab meaning "show everything" —
  using the string `"ALL"` as that meta-tab's identity would make the two
  indistinguishable in state (`selectedTicker === "ALL"` could mean
  either). `string | null` makes them representationally different: no
  valid ticker can ever equal `null`.

- **"Load more" state (`loadedMore`) lives inside `NewsFeed`, not lifted
  up into `page.tsx`'s `news` state.** `page.tsx`'s `news` array
  specifically represents "what arrived live over the WebSocket" — that's
  its whole contract with the reducer-adjacent state design from commits
  7–9. Manually-paged-in older articles are a different kind of thing (an
  explicit user request, not a live event), and folding them into the
  same array would blur that distinction for no benefit, since nothing
  outside `NewsFeed` needs to know about them.

- **Tabs are driven by the portfolio's ticker list (a new `tickers` prop
  from `page.tsx`), not by which tickers happen to already have news
  items.** A just-added ticker with zero news yet still gets a tab —
  clicking it shows the (already-existing) empty state, confirming "this
  ticker is tracked, there's just nothing yet" rather than that ticker
  having no way to be selected at all.

- **Client-side dedup by `ticker-url` runs on the combined (live + loaded-
  more) list before rendering**, on top of the backend's own
  `_broadcast_ids` guard (commit 12). Belt-and-suspenders: if a live
  WebSocket item and a "load more" page ever raced and both included the
  same article, this silently drops the second copy instead of rendering
  a visible duplicate — cheap insurance for a scenario the backend guard
  is already supposed to prevent.

- **Verification:** `tsc`/`eslint` clean, production build succeeds.
  Rebuilt and reran the Docker backend image (commit 11) with the new
  endpoint, hit it directly with `curl` to confirm the exact pagination
  behavior described in commit 12, then ran the real frontend against it
  and confirmed via SSR output that the "All" tab renders with no compile
  or runtime errors. Did not visually click through tabs / "Load more" in
  an actual browser — same no-headless-browser constraint as every
  frontend commit this session — but the network contract each UI action
  produces was verified directly against the real backend and real
  Alpaca data, which is the part most likely to have hidden a bug (as it
  did, in commit 12's `end`-is-inclusive finding).
