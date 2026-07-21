# PortfolioLive

A real-time portfolio dashboard: live stock prices, live P&L, and
AI-summarised news, filtered to whatever you hold.

## Architecture

```mermaid
flowchart LR
    subgraph alpaca["Alpaca Markets"]
        aws["WebSocket\n(IEX quotes)"]
        arest["REST\n(news + snapshots)"]
    end

    groq["Groq API\n(llama-3.3-70b)"]
    redis[("Redis")]

    subgraph backend["FastAPI backend"]
        routes["main.py\n(REST routes)"]
        ac["AlpacaClient"]
        ns["NewsService"]
        wm["WebSocketManager"]
        ps["PortfolioStore"]
    end

    subgraph frontend["Next.js frontend"]
        hook["useWebSocket hook"]
        ui["Dashboard UI"]
    end

    browser(("Browser"))

    aws -- "price ticks" --> ac
    arest -- "articles" --> ac
    ac -- "on_quote" --> wm
    ac -- "60s poll batches" --> ns
    ns -- "summarise" --> groq
    ns <-- "cache summaries" --> redis
    ps <-- "holdings" --> redis
    wm -- "P&L calc" --> ps
    wm -- "price_update / news_update" --> hook
    ns -- "news_update" --> hook
    hook --> ui
    routes --> ps
    routes -- "load more" --> ns
    ui -- "REST: add / remove / load more" --> routes
    ui --> browser
```

One Alpaca WebSocket connection is shared across every holding and every
connected browser tab — prices come in once from Alpaca and fan out to N
clients, not N Alpaca connections. News is polled over REST every 60s
(not streamed), summarised one sentence at a time by Groq, cached in
Redis, and pushed to clients over the same WebSocket as price ticks.

Full rationale for every non-obvious decision in this codebase — why the
Alpaca stream runs on its own thread, why `useReducer` vs `useState`,
why the Docker `CMD` needs `exec`, and so on — is in
[`DECISION_LOG.md`](./DECISION_LOG.md), organised per commit.

## Features

- Live price ticks and per-position P&L ($ and %) over WebSocket
- Portfolio table with a 20-point sparkline per holding
- Add / remove holdings, with optimistic UI updates
- AI-summarised news (one sentence, market-focused) per holding, with
  ticker tabs to filter and "Load more" to page further back in history
- Auto-reconnecting WebSocket client (exponential backoff, capped at 30s)

## Tech stack

| | |
|---|---|
| Backend | Python, FastAPI, WebSockets, Redis, [alpaca-py](https://github.com/alpacahq/alpaca-py) |
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind CSS, Recharts |
| AI | Groq (`llama-3.3-70b-versatile`) for one-line news summaries |
| Data | Alpaca Markets (free tier — 15-minute delayed IEX feed) |
| Deploy | Railway (backend, via Docker), Vercel (frontend) |

## Project structure

```
backend/
  main.py               FastAPI app, routes, WS endpoint, lifespan wiring
  alpaca_client.py       Alpaca WebSocket price stream + REST news polling
  websocket_manager.py   Fans price ticks out to connected frontend clients
  news_service.py        Groq summarisation, caching, dedup, broadcast
  portfolio_store.py     Redis-backed holdings CRUD
  models.py              Pydantic models shared across the backend
  tests/                 pytest — model validation
  Dockerfile, railway.toml, .dockerignore
frontend/
  app/
    page.tsx              Dashboard: state, WebSocket wiring, layout
    components/
      PortfolioTable.tsx   Holdings table with live P&L + sparklines
      PriceSparkline.tsx   Mini Recharts line chart per holding
      NewsFeed.tsx         AI news feed with ticker tabs + load more
      AddTickerForm.tsx    Add-holding form (optimistic UI)
  lib/
    websocket.ts           useWebSocket hook (auto-reconnect)
    types.ts                Shared TypeScript types (mirrors backend/models.py)
    format.ts               Currency / percent / relative-time formatting
.github/workflows/ci.yml   Lint + test on every PR (backend + frontend)
DECISION_LOG.md            Every non-obvious decision, organised per commit
```

## Getting started

### Prerequisites

- Python 3.12, Node 20+ (Node 22 recommended — see note below)
- Redis (local install, or `docker run -p 6379:6379 redis:7-alpine`)
- API keys: [Alpaca](https://alpaca.markets) (free — paper trading tier
  covers everything this app needs) and [Groq](https://console.groq.com)

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ALPACA_API_KEY, ALPACA_SECRET_KEY, GROQ_API_KEY
uvicorn main:app --reload
```

Runs on `http://localhost:8000`. `GET /health` should return `{"status": "ok"}`.

To also run the linter/tests locally:

```bash
pip install -r requirements-dev.txt
ruff check .
pytest
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # defaults already point at localhost:8000
npm run dev
```

Runs on `http://localhost:3000`.

> **Node version note:** `eslint-visitor-keys` requires Node `^20.19 ||
> ^22.13 || >=24`. Older Node 20.x patch versions will `npm install`
> successfully but print an `EBADENGINE` warning — harmless locally, but
> CI pins Node 22 specifically to avoid it.

### Docker (backend only)

```bash
cd backend
docker build -t portfoliolive-backend .
docker run -p 8000:8000 --env-file .env portfoliolive-backend
```

Note `REDIS_URL` inside `.env` needs to be reachable *from the
container* — `redis://host.docker.internal:6379` if Redis is running on
your host machine, not `localhost`.

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/portfolio` | Current holdings |
| `POST` | `/portfolio/add` | Add/update a holding (`{ticker, quantity, avg_cost}`) |
| `DELETE` | `/portfolio/{ticker}` | Remove a holding |
| `GET` | `/news/{ticker}?before=&limit=` | Page further back into a ticker's news |
| `WS` | `/ws` | Live `price_update` / `news_update` events |

## Known constraints

- **15-minute delayed data.** Alpaca's free tier uses the IEX feed, not
  full SIP — fine for a dashboard, not for trading decisions.
- **US-listed equities only.** A consequence of using Alpaca's *stock*
  data endpoints specifically (`StockDataStream`, stock news) — Alpaca
  also has crypto data, but this app doesn't touch it. Ticker validation
  itself doesn't enforce this; an invalid or unsupported ticker just sits
  with `—` placeholders forever, since it's subscribed but never receives
  data.
- **News has no replay for late-joining clients.** Broadcasts are
  push-only — a client that connects after a ticker's news has already
  gone out over the socket won't see it until either new articles appear
  or the backend restarts (which clears the in-process dedup set).
- **Sparklines don't persist across reloads.** Price history is
  accumulated client-side from live ticks only, not seeded from
  historical bars — reloading the page empties it back to zero.
- **Groq's free tier has rate limits** — the 5-minute Redis cache on
  news summaries exists specifically to avoid redundant calls for
  articles already summarised.

## Security

- API keys are backend-only, read from environment variables, never
  exposed to the frontend
- CORS restricted to a single configured `FRONTEND_ORIGIN`
- Ticker input validated (uppercase letters, 1–5 chars) on both frontend
  and backend
- `/portfolio/add` capped at 50 holdings total
