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

---

## Commit 14 — README with architecture diagram

**Files:** `README.md`

- **The architecture diagram is Mermaid, not a static image or ASCII
  art** — GitHub renders `mermaid` code fences natively in Markdown, so
  it stays readable in a diff (plain text) and doesn't need a separate
  export step or an image file to keep in sync with the text around it.

- **The diagram went through two draft/render/fix cycles before landing
  in the README, not one.** Installed `@mermaid-js/mermaid-cli` and
  actually rendered the diagram to SVG/PNG rather than trusting the
  syntax by inspection — the first draft had the frontend's "REST: add /
  remove / load more" edge pointing at the whole `backend` subgraph
  (Mermaid draws that as an arrow into the subgraph's boundary, not a
  specific node), which rendered as a confusing line crossing over the
  Groq box. Fixed by adding `main.py (REST routes)` as its own node in
  the diagram and pointing the edge there instead — which is also more
  architecturally accurate: `main.py` *is* the real REST entry point that
  delegates to `PortfolioStore`/`NewsService`, and the first draft's
  diagram was eliding that. Re-rendered to confirm the fix actually
  resolved the visual issue rather than just looking plausible in the
  markup.

- **"Known constraints" restates the spec's original three
  (15-min-delayed data, Groq rate limits, REST-not-WebSocket news) and
  adds three more discovered during actual development**: US-equities-only
  (a consequence of which Alpaca API this app calls, not an explicit
  restriction — noted in commit 2's file but never surfaced anywhere a
  reader would see it without reading the code), no news replay for
  late-joining clients (hit *live*, by the user, mid-session — see the
  conversation around commit 13), and sparklines not persisting across
  reloads (commit 10). Limitations that were only ever discussed in chat
  or buried in a single file's decision-log entry are exactly the kind of
  thing a README should surface, since they're the questions a new reader
  — or the user, months later — would actually ask.

- **Verification:** the Mermaid diagram was extracted and rendered to
  both SVG and PNG via `mmdc`, confirming valid syntax (not just
  eyeballed) and, via the PNG, that the layout is actually legible rather
  than merely syntactically valid. Every command in the "Getting started"
  section (venv creation, `pip install`, `ruff check`, `pytest`, `npm
  install`, `npm run dev`, `docker build`/`docker run`) matches commands
  already run and verified earlier in this project's development — this
  README doesn't introduce any new untested instructions, it documents
  paths that were already exercised.

---

## Commit 15 — Price alerts + portfolio analytics (backend)

**Files:** `backend/websocket_manager.py`, `backend/alert_store.py`, `backend/alert_service.py`, `backend/analytics_service.py`, `backend/models.py`, `backend/main.py`, `backend/tests/test_alert_service.py`

User-requested features, prioritized over lightweight auth and a
Prometheus endpoint (also proposed) as the two with the most product
value for the effort. Both build on a gap the codebase had until now: no
persistent record of "the current price of this ticker" — every tick was
turned into a broadcast and forgotten.

- **`WebSocketManager` gained a `last_prices` cache and a
  `add_quote_listener` hook, shared by both features.** Price alerts need
  the *previous* price to detect a crossing (not just "price is currently
  past the target," which would re-fire every tick); portfolio snapshots
  need "what's this holding worth right now" outside of a tick handler
  entirely. Both needs are met by the same cache. The listener hook keeps
  `WebSocketManager` from needing to import or know about `AlertService`
  — it calls whatever's registered with `(ticker, previous_price, price)`
  after every quote, the same loosely-coupled shape already used for
  `AlpacaClient`'s `on_quote`/`get_tickers`/`on_batch` callbacks. Listener
  exceptions are caught and logged individually so one broken listener
  can't take down price broadcasting for everyone.

- **Alert crossing is "previous < target ≤ new" (or the mirror for
  below), not "new ≥ target."** The latter would fire on *every* tick
  once the price is past the target, not once. Verified with a
  parametrized test (`test_alert_service.py`) covering landing exactly on
  the target, jumping clean over it, and the "already past, moving
  further away" case that a naive `price >= target` check would
  incorrectly re-trigger.

- **Alerts can only be created for tickers already held.** Checked
  against a real trap: alerts only ever get evaluated from inside
  `on_quote`, which only fires for tickers Alpaca is actually subscribed
  to — and that subscription is driven entirely by portfolio holdings.
  An alert for an unheld ticker would never receive a tick to compare
  against and would sit forever, silently dead, with no error to explain
  why. Supporting watchlist-style alerts (not-yet-owned tickers) would
  mean giving alerts their own Alpaca subscription lifecycle independent
  of holdings — meaningfully bigger scope than what was asked for.

- **Removing a holding cascades to delete its alerts**
  (`delete_alerts_for_ticker`, called from `DELETE /portfolio/{ticker}`).
  Without this, an orphaned alert would sit in the list forever, looking
  active, for a ticker that can now never produce a tick to check it
  against.

- **Portfolio snapshots store per-ticker data, not just portfolio
  totals.** "Best/worst performer" is a per-ticker question — computing
  it later from portfolio-level totals alone would be impossible. Each
  hourly snapshot (`PortfolioSnapshot`, stored as JSON in a Redis sorted
  set scored by unix timestamp, so "last N days" is a range query, not a
  scan) carries `{price, value, pnl_pct}` per ticker alongside the totals.

- **A ticker with no known price yet is skipped in a snapshot, not
  defaulted to `avg_cost`.** Falling back to cost basis would silently
  represent "we don't know" as "no change since purchase," which is a
  fabricated data point sitting in a history chart, not an honest gap.

- **Best/worst performer is always a fixed 7-day window, independent of
  whatever `days` the chart itself was asked for.** It's part of the
  feature's definition ("over the last 7 days"), not a parameter — a
  30-day chart request shouldn't silently change what "best/worst
  performer" means. Implemented as a second, separate range query rather
  than deriving it from the chart's own (differently-windowed) history.

- **"Total return since inception" reuses the latest snapshot's
  `total_pnl`/`total_pnl_pct` rather than computing a second, separately-
  defined "return since tracking began" number.** For a personal
  portfolio, "P&L since you bought these positions" *is* "since
  inception" — inventing a distinct snapshot-based definition (e.g.
  value-now vs. value-at-first-snapshot) would produce a second number
  answering a subtly different question for no clear benefit, and would
  diverge from the dashboard's own top-line P&L stat for no good reason.

- **`GET /analytics` and `snapshot_once()` are separate from the hourly
  loop**, callable independently. `snapshot_once()` is what the loop
  calls on a timer, but keeping it a standalone method (not inlined into
  the loop) is what made it possible to verify the whole pipeline —
  ticks in, snapshot out, math correct — without waiting real hours
  between data points (see verification below).

- **Live verification, in two parts, since the market was closed for
  this whole session (see commit 7a) and a running Docker container
  can't have external Python calls injected into its internal objects:**
  1. *Alerts:* wired real `PortfolioStore` + `WebSocketManager` +
     `AlertStore` + `AlertService` against real Redis in a standalone
     script (not mocks), created a real alert, fed two `on_quote` calls
     simulating a price crossing $210. Confirmed: first tick establishes
     the baseline with no false trigger, second tick broadcasts both the
     `price_update` *and* a `price_alert` message with the correct
     `direction`, and the alert's `triggered` flag persists as `true` in
     Redis afterward.
  2. *Analytics:* same approach — real code, real Redis, fed three rounds
     of synthetic ticks at different prices, called `snapshot_once()`
     after each, then hand-verified every number `get_analytics()`
     returned against the input prices (cost basis, per-ticker `pnl_pct`,
     `best_performer_7d`/`worst_performer_7d` percentages) — all matched
     exactly.
  Also rebuilt and ran the real Docker image (commit 11) against real
  Redis/Alpaca/Groq: confirmed `POST/GET/DELETE /alerts` end-to-end
  (including the "not in your portfolio" 400 and the cascade-delete on
  holding removal), and confirmed `GET /analytics` returns a correct
  empty state (`history: []`, both performers `null`) when no snapshot
  yet exists — which is what actually happened in the live container,
  since `last_prices` was empty the whole time the market was closed.

---

## Commit 16 — Price alerts + portfolio analytics (frontend)

**Files:** `frontend/app/components/Toast.tsx`, `frontend/app/components/PortfolioTable.tsx`, `frontend/app/page.tsx`, `frontend/app/analytics/page.tsx`, `frontend/lib/types.ts`

- **Alert-setting UI is inline per row in `PortfolioTable`, not a modal or
  a separate page.** The user's own framing was "notify me when AAPL
  hits $200" — a per-ticker action taken right where that ticker already
  lives on screen. A modal or dedicated alerts page would add navigation
  for something that's naturally a one-line "ticker, price, go."

- **Alert creation is *not* optimistic**, unlike `handleAdd`/`handleRemove`
  (commits 7/9). Those mutate client-generated or already-known state; an
  alert's `id` is a server-generated UUID, so there's nothing valid to
  render until the response comes back. An optimistic version would need
  a fake placeholder id that then has to be reconciled with the real one
  once the response arrives — more moving parts for a form submission
  that's already fast (no external API call in the request path, just a
  Redis write).

- **`ToastStack`/`ToastItem` split so each toast owns its own dismiss
  timer**, rather than `page.tsx` tracking a timer per toast in a list it
  doesn't otherwise need timing details about. `page.tsx` just appends to
  an array on a `price_alert` message and removes by id on dismiss — the
  "how long has this been visible" concern lives entirely inside the
  component displaying it.

- **A triggered alert is marked `triggered: true` in local state on
  receipt of the `price_alert` WS message, not removed outright.**
  `PortfolioTable` already filters to `!alert.triggered` when deciding
  which chips to show per ticker, so marking (rather than deleting)
  produces the same visible result while keeping the alert's history
  available if something later wants to show "this fired" rather than
  just "this is gone."

- **The analytics page charts `total_pnl_pct` over time, not raw
  `total_value`.** Percentage return is comparable across days regardless
  of how much was added to or removed from the portfolio in between (an
  `ADD_HOLDING` mid-week would make a raw-value chart jump for a reason
  that has nothing to do with performance); percent P&L stays meaningful
  regardless.

- **"Best/worst performer" renders its own distinct empty state** ("not
  enough history — needs at least two snapshots spanning 7 days") rather
  than reusing the chart's "not enough history yet" message. The two
  sections can genuinely be in different states at the same time — a
  30-day chart can have plenty of points while the *7-day* window
  specifically (a fixed sub-range, per commit 15) doesn't yet have two
  snapshots to compare — so collapsing them into one message would
  sometimes describe the wrong section.

- **Verification:** `tsc`/`eslint` clean, production build succeeds with
  both routes (`/` and `/analytics`) generated. Rebuilt and ran the real
  Docker backend, started the frontend against it, and confirmed via SSR
  that both pages compile and render their correct initial states (empty
  portfolio dashboard, analytics "Loading…") with no runtime errors.
  Exercised the exact requests each new UI action produces directly
  against the live backend: created an alert via the same
  `POST /alerts` body `handleSetAlert` sends, deleted it via the same
  `DELETE /alerts/{id}` `handleDeleteAlert` sends, and confirmed
  `GET /analytics` returns the shape `AnalyticsResponse` expects. As with
  every frontend commit this session, didn't visually click through the
  toast/alert-chip/chart UI in an actual browser (no headless browser
  tool available) — the crossing-detection logic itself was verified
  through real production code in commit 15, not re-verified here at the
  UI layer.

---

## Commit 17 — Fired-alert history + per-stock analytics charts (frontend)

**Files:** `frontend/app/components/PortfolioTable.tsx`, `frontend/app/analytics/page.tsx`

User-reported gap, found while testing commit 16: a triggered alert
disappeared from the UI entirely (`PortfolioTable` filtered to
`!alert.triggered`), so missing the toast — e.g. tab closed when it fired
— meant no record anywhere that it had happened at all.

- **Fired alerts are now shown, not hidden, distinguished by a muted `✓`
  chip vs. the active `🔔` chip** — both still removable via the same `×`
  (deleting an alert was never conditional on `triggered` on the backend,
  so no backend change was needed here). Kept as a flat list rather than
  splitting into two visually separate groups per ticker — with typically
  one or two alerts per holding, a second grouping layer would be
  structure for structure's sake.

- **Per-stock charts required no backend change at all.** Each
  `PortfolioSnapshot` in `AnalyticsResponse.history` already carries
  per-ticker `{price, value, pnl_pct}` (commit 15, built for best/worst
  performer) — plotting one ticker's `pnl_pct` over time is just filtering
  and mapping data already being sent, not a new data requirement.

- **"Which tickers get a chart" is read from the *latest* snapshot's
  holdings, not the union of every ticker that ever appeared in the
  30-day window.** Consistent with the rest of the dashboard (the
  Holdings table only ever shows current holdings) — a ticker sold last
  week doesn't get a chart here either, for the same reason it doesn't
  get a row in the table.

- **Per-ticker line color is the *current* `pnl_pct` sign** (last point in
  that ticker's series), not the trend-within-window logic
  `PriceSparkline` deliberately uses (commit 10). This chart *is* a P&L%
  chart — "is this position up or down right now" is exactly what it's
  showing, so coloring by anything else would be the wrong answer for
  this specific chart, unlike the sparkline (which is about recent price
  movement, not overall position performance, and says so explicitly).

- **Verification:** `tsc`/`eslint` clean, production build succeeds.
  Seeded 5 realistic synthetic snapshots directly into the real backend's
  Redis (same approach as commit 15's isolated verification, but this
  time against the actual shared Redis instance the running Docker
  container reads from) and confirmed via `curl` that `GET /analytics`
  returns them with correct per-ticker `pnl_pct` data. Restarted the
  frontend dev server against the live backend and confirmed the
  `/analytics` route still compiles and serves 200 with the new section
  present in the component tree. Did not visually confirm the rendered
  charts in a browser.

---

## Commit 18 — Last-known price on page load

**Files:** `backend/main.py`, `backend/models.py`, `backend/websocket_manager.py`, `frontend/lib/types.ts`, `frontend/app/page.tsx`

User-asked-and-answered: "does the holding value only show when the
market's open?" — yes, because `GET /portfolio` only ever returned
`{ticker, quantity, avg_cost}`, so every fresh page load started blank
until the *next* live tick, even if the backend process already knew the
last real price from earlier in the day (or an earlier session).

- **`WebSocketManager.enrich_holdings` reuses the exact P&L formula
  `on_quote` already had inline**, now extracted into a shared
  `_position_math` static helper. Two call sites computing "cost basis,
  position value, P&L, P&L%" independently would be two places that could
  quietly drift out of sync if the formula ever changed in one but not
  the other — a live tick and a page-load snapshot should never be able
  to disagree about what a position is worth for the same price.

- **`HoldingWithPrice` is a new model, not four new optional fields bolted
  onto `Holding`.** `Holding` is also `POST /portfolio/add`'s request
  body — adding response-only fields directly to it would make the
  request schema (visible in `/docs`) misleadingly show `price`/`position_value`/etc.
  as things a client could theoretically send when creating a holding,
  which they can't and shouldn't.

- **`GET /portfolio` uses `response_model_exclude_none=True`, so a holding
  with no known price omits those fields from the JSON entirely rather
  than sending explicit `null`s.** This matters beyond style: the
  frontend's `PortfolioRow`/`HoldingWithPrice` types already treat "field
  absent" as "no data yet" everywhere else in the app (commit 7's
  `hasLiveData = row.price !== undefined` check). Sending explicit nulls
  would've needed either a second convention on the frontend or a risk of
  a `null` silently overwriting a real price already sitting in state
  from a WebSocket tick that arrived first — omission was the one-line
  fix that avoided introducing either problem.

- **Verification, in two parts, since the running Docker container's
  in-memory `_last_prices` resets on every rebuild/restart (documented
  behavior, not a bug) and the market's been closed this whole session:**
  1. Real code, real Redis, real holdings (including one I didn't add
     myself — a `GOOG` position turned up in the shared Redis from
     between-session testing, left alone rather than "cleaned up," since
     it's exactly the kind of incidental real data this feature needs to
     handle correctly): called `enrich_holdings` before and after a
     simulated tick, confirmed only the ticked ticker gets populated,
     confirmed the math (`AAPL` at `$211.50`, qty 10, avg cost `$200` →
     `$2,115` value, `$115` P&L, `5.75%`), and confirmed the
     `exclude_none` JSON shape matches exactly what the real route
     produces.
  2. Rebuilt and ran the actual Docker image, confirmed `GET /portfolio`
     on a cold start correctly omits price fields entirely for every
     holding (200, no crash, no stray `null`s) — the honest "don't know
     yet" state, which is what a real user hitting this right now (market
     closed, fresh container) will actually see until the market reopens
     and this process observes its first tick.

---

## Commit 19 — Prometheus /metrics endpoint

**Files:** `backend/metrics.py`, `backend/websocket_manager.py`, `backend/news_service.py`, `backend/main.py`, `backend/requirements.txt`

- **One central `metrics.py`, not a `Counter`/`Gauge` declared locally in
  each file that needs one.** `prometheus_client` metrics register
  themselves on a global default registry at creation time —
  instantiating the same metric name in two places (easy to do by
  accident across files with no shared reference) raises at import time.
  A single module every consumer imports from makes that structurally
  impossible rather than something to remember not to do.

- **Cache hit rate is two raw counters (`news_cache_hits_total`,
  `news_cache_misses_total`), not a single precomputed ratio gauge.**
  This is the idiomatic Prometheus pattern, not an arbitrary choice: a
  ratio computed and stored server-side can only ever answer "since the
  process started," while raw counters let PromQL compute a rate over
  whatever window is actually useful
  (`rate(hits[5m]) / (rate(hits[5m]) + rate(misses[5m]))`). Since part of
  the point of this endpoint is demonstrating familiarity with how
  Prometheus metrics are actually consumed, doing it the textbook way
  mattered more than it would for an internal-only convenience number.

- **`news_summaries_generated_total` increments once per
  `_build_news_item` call**, which both the 60s broadcast path
  (`_process_article`) and the on-demand `get_more_news` path funnel
  through — one counter covers "a news item was produced and shown to a
  client," regardless of which of the two ways it got there, rather than
  needing two separately-tracked-and-then-summed counters.

- **`/metrics` is unauthenticated**, alongside `/health` — flagged
  explicitly here because the very next commit (JWT auth) protects
  everything else. A Prometheus scraper polling on a fixed interval has
  no route to a login flow any more than Railway's own health checker
  does; both need to be reachable without a token by design, not by
  oversight.

- **Verification:** rebuilt and ran the real Docker image against real
  traffic — confirmed real counts after real Groq calls (12 calls, 12
  summaries generated, 0 hits / 12 misses, internally consistent since
  every summary that cycle needed a fresh call). For the WebSocket gauge
  specifically, isolated a controlled test from an unrelated confound:
  the gauge read `2` at baseline from what was almost certainly the
  user's own open browser tab(s) reconnecting via their WebSocket hook's
  auto-reconnect (commit 6) after a container restart — not a bug, just
  real concurrent usage during testing. Connected one fully-controlled
  script-driven client, confirmed the gauge incremented to `3` while it
  was held open, then confirmed it dropped back to `2` immediately after
  that specific client disconnected — proving the metric moves in the
  correct direction under a known, isolated change, independent of
  whatever else happened to be connected at the time.

---

## Commit 20 — Single-user JWT auth (backend)

**Files:** `backend/auth.py`, `backend/main.py`, `backend/models.py`, `backend/requirements.txt`, `backend/.env.example`, `backend/tests/test_auth.py`

- **Credentials are bootstrapped from `AUTH_USERNAME`/`AUTH_PASSWORD` env
  vars into Redis on startup, idempotently — not created via an open
  `/auth/register` endpoint.** A registration endpoint reachable without
  auth is, definitionally, a way for anyone to create or overwrite the
  single account this app has; env-var bootstrap matches how every other
  secret already works here (`ALPACA_API_KEY` etc.) and needs no new
  onboarding flow for a single-user personal app. "Idempotent" is load-
  bearing, not incidental: without the `if existing is not None: return`
  guard, every backend restart would silently reset the password back to
  whatever's in the env file, undoing a password rotated by editing Redis
  directly.

- **Auth is enforced at the `APIRouter` level
  (`protected = APIRouter(dependencies=[Depends(require_auth)])`), not
  as `dependencies=[Depends(require_auth)]` repeated on each of the 8
  routes it covers.** A per-route opt-in is one added route away from an
  accidental unauthenticated leak — someone adds route #9 later, forgets
  the dependency, ships a hole. A router-level default makes "protected"
  the thing a route has to opt *out* of (by living outside the router)
  rather than opt into, which is the safer default direction for this
  specific mistake to be hard to make.

- **The WebSocket endpoint authenticates via a `?token=` query param, not
  the `Authorization` header the REST routes use.** Not a stylistic
  choice — browsers' native `WebSocket` constructor has no way to set
  custom headers on the handshake at all, so the header pattern simply
  isn't available here. Verified live, and worth recording precisely:
  calling `websocket.close(code=4401, ...)` *before* `accept()` doesn't
  send a WS close frame carrying that code to the client — Starlette/
  uvicorn instead refuse the handshake with a plain HTTP 403, discarding
  the custom code entirely (confirmed via `websockets` client logs: `HTTP
  403`, not a close-frame-with-code-4401 event). The code fixes this
  in a comment rather than in behavior, since the 403 rejection is
  already the correct outcome — the client-observable difference just
  isn't what a `code=4401` might suggest to a future reader.

- **`HTTPBearer()`'s default `auto_error=True` means a *missing* token
  gets FastAPI's own `403 Forbidden`, while an *invalid or expired* one
  gets this app's own `401` from `require_auth`.** Slightly inconsistent
  status codes for two flavors of "not authenticated," and worth knowing
  rather than "fixing" by setting `auto_error=False` and hand-rolling the
  missing-header case — that would just be reimplementing what FastAPI's
  default already does correctly, to make two error codes match at the
  cost of more code.

- **Password hashing via `bcrypt` directly, JWT via `PyJWT` directly** —
  not `passlib` (its bcrypt backend has had compatibility churn with
  newer `bcrypt` releases) or `python-jose` (multiple JWT libraries doing
  the same one job with different maintenance trajectories). Both chosen
  libraries are the thing they claim to be and nothing more, which is
  what a two-function need (`hashpw`/`checkpw`, `encode`/`decode`) here
  actually calls for.

- **Unit tests cover only `create_token`/`verify_token`** (pure — no
  Redis I/O), including one that constructs two `AuthService`s with
  different secrets and confirms a token signed by one is rejected by
  the other. `bootstrap_user`/`verify_login` need a real Redis connection
  and are covered by live verification instead, same split already used
  throughout this backend (e.g. commit 15's alert tests).

- **Verification, against the real Docker image, not just code review:**
  confirmed the full matrix live — `GET /portfolio` with no token → `403`;
  with a garbage token → `401`; `POST /auth/login` with a wrong password
  → `401`; with correct credentials → a real token; that same token used
  successfully for both a `GET` and a `POST /portfolio/add` (then cleaned
  up); every protected route (`/alerts`, `/analytics`, `/news/{ticker}`)
  confirmed to `403` with no token, while `/health` and `/metrics` stayed
  open; a raw WebSocket client confirmed rejected with no token
  (`InvalidStatus... HTTP 403`, matching the close-before-accept finding
  above) and confirmed accepted with a valid one. Checked the container's
  own logs after each step to confirm every rejection was a clean,
  intentional refusal — no unhandled exceptions anywhere in the auth path.

---

## Commit 21 — Single-user JWT auth (frontend) + README updates

**Files:** `frontend/lib/auth.ts`, `frontend/app/login/page.tsx`, `frontend/app/page.tsx`, `frontend/app/analytics/page.tsx`, `frontend/app/components/NewsFeed.tsx`, `README.md`

- **Token storage is `localStorage`, not an httpOnly cookie.** A cookie
  would be more resistant to XSS, but the frontend (Vercel) and backend
  (Railway) are different origins — an httpOnly cookie set by the backend
  would need cross-site cookie config (`SameSite=None; Secure`, and the
  backend deciding the cookie's domain) that adds real complexity for a
  single-user personal dashboard, not a multi-tenant product where
  session-theft blast radius matters more. Named explicitly as a
  simplicity-over-hardening tradeoff, not an oversight.

- **`useRequireAuth`'s check runs inside a `useEffect`, and the token read
  itself is synchronous (`localStorage.getItem`) — it's not "async" in
  the sense of needing to be awaited, but it still can't run during the
  first render.** Next.js renders this "use client" component's first
  pass on the server, where `window` doesn't exist and `getToken()`
  correctly returns `null` (guarded) rather than throwing — but checking
  during render and redirecting from there would either act on that false
  "no token" reading, or cause a server/client hydration mismatch if it
  tried to render different output on each side. The effect defers the
  check to after hydration, when `localStorage` reflects reality.

- **Every page gated by `useRequireAuth` still calls all its other hooks
  unconditionally, and only returns `null` afterward** (`if (!ready)
  return null` placed right before the JSX, not before the hook calls
  above it). Rules of Hooks: hook calls can't be conditional on `ready`
  itself, since `ready` is *produced by* one of those hooks.

- **The WebSocket URL gets `?token=` appended in `page.tsx` (the only
  place `useWebSocket` is called), not inside the hook itself.** The hook
  (commit 6) has no reason to know what a "token" is — it takes a URL and
  manages a connection to it; auth is a concern of the one caller that
  needs it; passing a fully-formed URL keeps the hook's contract exactly
  as narrow as it was before this feature existed. `useWebSocket`'s
  internal effect keys off the URL string's value, so recomputing the
  same string across re-renders (as long as the token hasn't changed)
  doesn't trigger a spurious reconnect.

- **A `Log out` button was added even though it wasn't explicitly asked
  for.** A login flow with no way to end the session is an incomplete
  loop — this is the same class of "obviously implied by what was
  requested" addition as the remove button on `AddTickerForm`'s row back
  in commit 7, not scope creep.

- **README updated in the same commit, not deferred.** The architecture
  diagram (commit 14) predates alerts, analytics, metrics, and now auth
  entirely — the Features list, API reference table, env var
  instructions, and Security section were all stale enough to actively
  mislead a new reader (the API table was still missing 6 of the 14 real
  routes). Left the Mermaid diagram itself unchanged: auth is a request-
  level gate applied uniformly across the existing data flow, not a new
  pipeline — annotating every edge with "requires a token" would add
  visual noise without adding information a reader doesn't already get
  from the new "API reference" note above the table.

- **Verification:** `tsc`/`eslint` clean, production build succeeds with
  all three routes (`/`, `/analytics`, `/login`) generated. Confirmed via
  `curl` that the dashboard's SSR output contains no dashboard content
  (title only) — the `if (!ready) return null` gate doing its job on the
  very first render — and that `/login`'s SSR includes the actual form
  fields. Did not drive an actual browser through the login → redirect →
  authenticated-fetch loop (same constraint as every frontend commit this
  session); the network contract each step relies on (login response
  shape, 401 handling, `?token=` on the WS URL) was verified directly
  against the real backend in commit 20, and the frontend code
  implementing it type-checks and builds against that same contract.

---

## Commit 22 — Watchlist mode (backend)

**Files:** `backend/watchlist_store.py`, `backend/websocket_manager.py`, `backend/news_service.py`, `backend/main.py`, `backend/models.py`

User-pitched feature: tickers tracked for price/news without being owned.
The "architecturally trivial — a second Redis set" framing undersold one
part of it: `WebSocketManager.on_quote` had a hard assumption baked into
its very first line (`if holding is None: return`) that every tick
belongs to a portfolio position. Making a tick for an unowned, watched
ticker actually *reach* a client required changing that dispatch, not
just adding storage for the tickers themselves.

- **`WatchlistPriceUpdate` is a new WS message type, not `PriceUpdate`
  with optional `position_*` fields.** Every existing consumer of
  `price_update` — the frontend's portfolio reducer, `PortfolioTable` —
  already assumes a real position (quantity, avg_cost, P&L) sits behind
  every message of that type. Overloading the type to sometimes carry
  P&L and sometimes not would push a "which kind is this" check onto
  every current and future consumer; a distinct `type` answers that
  question once, at the point a message is dispatched, matching the same
  reasoning already used for `PriceAlertTriggered`.

- **`on_quote` now branches on holding-vs-watchlist, but a ticker is never
  treated as both.** `POST /portfolio/add` auto-removes the ticker from
  the watchlist if present; `POST /watchlist/add` rejects a ticker
  that's already a holding (`400`). This isn't just tidiness — `on_quote`
  checks `holding is None and await self._watchlist.has_ticker(ticker)`
  to decide which message type to send, and if a ticker could
  legitimately be in both stores at once, that check would need a
  documented precedence rule instead of being a clean either/or.

- **Buying a watchlisted ticker migrates it out of the watchlist, but
  removing a *holding* does not auto-add it back to the watchlist.** The
  first direction is unambiguous: you're not "just watching" something
  you now own, and leaving it in both places would show it twice with no
  clear reason why. The second direction has no equally obvious answer
  (does selling mean you want to keep watching it, or are you done with
  it entirely?) — left as a manual re-add rather than guessing the
  answer to a question the feature request didn't address.

- **This closes a gap explicitly logged as out-of-scope in commit 15**:
  `POST /alerts` used to require the ticker be a portfolio holding,
  specifically because an alert on an unwatched ticker would never
  receive a tick to check against — "supporting watchlist-style alerts...
  would mean giving alerts their own subscription lifecycle... a bigger
  change than this feature asked for." Watchlist mode *is* that bigger
  change, now that it exists — updated `create_alert`'s validation to
  accept either a holding or a watched ticker, since both are genuinely
  subscribed on Alpaca and both will actually receive ticks to compare
  against. Not new scope smuggled in — a documented deferred decision
  revisited now that its stated precondition is met.

- **A third model (`WatchlistAdd`) needing the exact same ticker-format
  validation as `Holding` and `PriceAlertCreate` was the point where
  copy-pasting the validator body a third time stopped being the
  simpler option** — extracted into a shared `_validate_ticker` function
  that all three `@field_validator`s call, while keeping each model's own
  validator decorator (still no shared base class: the three models
  validate the same field for three unrelated reasons — own it, watch a
  price on it, watch it without owning it — and forcing them into a
  common parent to save four lines each isn't a good trade).

- **`NewsService._get_portfolio_tickers` was renamed
  `_get_tracked_tickers`** and now unions portfolio holdings with
  watchlist tickers, rather than adding a second, parallel polling path
  for watchlist news. One 60s poll cycle, one combined ticker set — Alpaca's
  news endpoint doesn't care why a ticker is being asked about.

- **Live verification, following the same real-code-real-Redis pattern as
  every stateful feature this session:** confirmed `POST /watchlist/add`
  rejects an already-held ticker (`400`) and succeeds for a new one;
  simulated ticks for a portfolio holding, a watchlist ticker, and an
  untracked ticker through the real `on_quote` in one script — confirmed
  exactly two broadcasts (not three), with the holding producing
  `price_update` and the watchlist ticker producing
  `watchlist_price_update`, each with the right fields present/absent.
  Confirmed live: an alert created on a watchlist-only ticker now
  succeeds (previously would `400`); buying a watchlisted ticker
  correctly empties the watchlist while the alert on it survives
  untouched; removing a watchlist ticker cascades to delete its alerts,
  mirroring `remove_holding`'s existing behavior. Confirmed
  `NewsService._get_tracked_tickers` returns the union of both stores
  against real Redis data. Checked the container's logs after all of the
  above — no errors.

---

## Commit 23 — Watchlist mode (frontend) + README updates

**Files:** `frontend/app/components/Watchlist.tsx`, `frontend/app/page.tsx`, `frontend/lib/types.ts`, `README.md`

- **A second `useReducer` (`watchlistReducer`), not a shared reducer with
  `portfolioReducer` and not folded into the same state shape.** The two
  nearly mirror each other structurally (set-from-fetch, optimistic
  add/remove, merge-in-live-ticks), but a holding and a watchlist row are
  different enough types — no `quantity`/`avg_cost`, no P&L fields at all
  — that combining them into one reducer would mean every piece of code
  reading that state has to branch on which kind of row it's looking at.
  Two reducers, two clearly-typed states, no branching needed anywhere
  that consumes them.

- **Adding a ticker to the watchlist is optimistic (unlike setting an
  alert, commit 16, which isn't).** The two client-generated-vs-server-
  generated-identity cases are different: a watchlist entry's whole
  identity *is* the ticker string, which the client already has before
  the request completes — nothing to reconcile once the response arrives.
  An alert's identity is a server-generated UUID the client can't predict.

- **The watchlist section sits in the same left column as Holdings, not
  the right column with News**, even though the pitch described it as "a
  separate section." Splitting Holdings and Watchlist across two columns
  would visually pair Watchlist with News instead of Holdings, when the
  two tables (holdings, watchlist) are the more natural pair — both are
  "things with tickers and live prices," while News is a different kind
  of content entirely.

- **`NewsFeed`'s `tickers` prop now receives both portfolio and watchlist
  tickers** (`[...rows, ...watchlistRows].map(...)`) so a watchlist
  ticker gets its own filter tab — no change needed inside `NewsFeed`
  itself, since `page.tsx` already forwards every `news_update` message
  regardless of source; only the tab list needed widening.

- **README updated again in the same commit** (Features, API reference,
  Known constraints untouched — none of the existing caveats needed
  revising for this feature) rather than deferred, same reasoning as
  commit 21: a reader hitting the API table should see all 15 real
  routes, not the 12 that existed before this feature.

- **Verification:** `tsc`/`eslint` clean, production build succeeds with
  all three routes unchanged in count (watchlist is a new section on the
  existing dashboard route, not a new page). Confirmed via the real
  backend (commit 22) that the exact requests `handleAddToWatchlist`/
  `handleRemoveFromWatchlist` produce succeed end-to-end. As with every
  frontend commit this session, did not visually confirm the rendered
  watchlist table/sparklines in an actual browser.

---

## Commit 24 — Fix: unauthenticated first load crashed the whole app

**Files:** `frontend/lib/auth.ts`, `frontend/app/page.tsx`, `frontend/app/analytics/page.tsx`

Found by the user, live, on a real browser: "Application error: a
client-side exception has occurred." Every prior frontend commit this
session had noted the same caveat — no headless browser available to
visually verify — and this is exactly the class of bug that gap let
through: something that only breaks in a real browser processing a real
response, not something `tsc`/`eslint`/a production build would ever
catch.

- **Root cause, confirmed with an actual browser console capture (see
  below), not inferred:** FastAPI's `HTTPBearer()` (backend/main.py,
  commit 20) returns `403` when the `Authorization` header is *missing
  entirely*, and only this app's own `401` when a token is present but
  invalid/expired — a distinction already written down in commit 20's
  decision log but never actually wired into `authFetch`, which only
  reacted to `401`. A brand-new browser with no token yet hits exactly
  the 403 case on its very first request. `authFetch` returned that 403
  response unchanged; the calling code in `page.tsx` unconditionally
  called `res.json()` on it and dispatched the result — an error body
  shaped like `{"detail": "Not authenticated"}` — as if it were the
  holdings array. `portfolioReducer`'s `for (const holding of
  action.holdings)` then threw `TypeError: action.holdings is not
  iterable`, an uncaught exception in a render path, which is what
  React/Next.js surfaces as "Application error."

- **Two fixes, not one, because either alone is incomplete:**
  1. `authFetch` now treats `403` the same as `401` (clear the token,
     redirect to `/login`) — the actual auth-state-repair action.
  2. Every initial data-fetch effect (`GET /portfolio`, `/watchlist`,
     `/alerts` in `page.tsx`; `/analytics` in `analytics/page.tsx`) now
     checks `res.ok` before calling `.json()`, throwing into `.catch()`
     otherwise. This one is the actual crash fix: `window.location.href =
     "/login"` does not halt JavaScript execution — the `.then()` chain
     already in flight keeps running for a moment while the navigation
     is still pending, so fix #1 alone does not reliably stop the bad
     body from still being parsed and dispatched before the redirect
     takes effect. Fix #2 makes that race irrelevant, and also makes
     every one of these fetches robust against *any* non-OK status (a
     500, a network-layer hiccup returning an HTML error page, not just
     401/403 specifically) — not a narrower fix aimed only at
     reproducing today's exact failure.

- **Verification used a real headless browser for the first time this
  session — Playwright + Chromium, installed specifically to chase this
  bug down** rather than continuing to reason about frontend code from
  static analysis alone. This is a capability gap worth naming plainly:
  every prior frontend commit's decision log entry says some version of
  "did not visually confirm in an actual browser" — that caveat was
  covering exactly this class of bug, and one finally reached the user
  because of it. Concretely, with a real browser:
  - Reproduced the crash first, with the exact console output pinned in
    this log entry's root-cause description above — a real
    `[pageerror]` event with the real stack trace, not a guess.
  - Confirmed the fix: reloading with no token now redirects cleanly to
    `/login` with zero page errors (only the expected, harmless 403s in
    the network log on the way there).
  - Drove an actual login (filled the real form, clicked submit) and
    confirmed the dashboard renders correctly post-auth: Holdings,
    Watchlist, and Total Value/P&L all present, zero console errors.
  - Interacted with the running app for the first time this session —
    submitted the "watch a ticker" form for TSLA and confirmed it
    actually appeared in the watchlist table.
  - Screenshotted the dashboard and the analytics page and visually
    confirmed both render correctly (analytics still showing the
    synthetic snapshots seeded during commit 17's verification — real
    data, real chart, real per-holding breakdown, all rendering as
    designed).
  This changes what "verified" should mean for frontend work going
  forward in this project: a headless browser is available and now
  known to work in this environment, so future frontend commits should
  use it rather than defaulting to the network-contract-only
  verification this session relied on before today.
