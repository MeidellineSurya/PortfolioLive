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
