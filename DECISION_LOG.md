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
