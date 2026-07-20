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
