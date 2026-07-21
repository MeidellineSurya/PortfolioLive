"""FastAPI app entry point: REST routes + the /ws endpoint."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from alpaca_client import AlpacaClient
from models import TICKER_RE, Holding, NewsItem
from news_service import NewsService
from portfolio_store import PortfolioStore
from websocket_manager import WebSocketManager

load_dotenv()

# Without this, every logger.info/logger.exception call in this codebase
# (alpaca_client.py, websocket_manager.py, news_service.py) is invisible:
# with no handler configured anywhere in the chain, Python only prints
# WARNING+ via its "handler of last resort", and even that has no
# timestamps or module names. This is operationally important for a
# long-running background process — the price-stream thread and news
# poller both run unattended and need to be debuggable from logs alone.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

MAX_HOLDINGS = 50


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = PortfolioStore(os.environ["REDIS_URL"])

    # AlpacaClient captures the running loop at construction time (see
    # decision log, commit 2) — it must be built inside this async
    # lifespan, not at import time.
    manager: WebSocketManager

    async def on_quote(ticker: str, price: float) -> None:
        await manager.on_quote(ticker, price)

    alpaca_client = AlpacaClient(
        api_key=os.environ["ALPACA_API_KEY"],
        secret_key=os.environ["ALPACA_SECRET_KEY"],
        on_quote=on_quote,
    )
    manager = WebSocketManager(alpaca_client, store)
    news_service = NewsService(
        alpaca_client=alpaca_client,
        portfolio_store=store,
        ws_manager=manager,
        groq_api_key=os.environ["GROQ_API_KEY"],
        redis_url=os.environ["REDIS_URL"],
    )

    app.state.store = store
    app.state.alpaca_client = alpaca_client
    app.state.ws_manager = manager
    app.state.news_service = news_service

    alpaca_client.start()
    try:
        await manager.load_initial_holdings()
        news_service.start()
        yield
    finally:
        # Alpaca allows exactly one active stream connection per account —
        # if anything after start() (Redis, news setup) raises, skipping
        # this leaves that connection open with nothing left to close it,
        # locking out every subsequent start until Alpaca's own server-side
        # timeout eventually notices the client is gone.
        await alpaca_client.stop()
        await store.close()


app = FastAPI(title="PortfolioLive API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/portfolio")
async def get_portfolio() -> list[Holding]:
    return await app.state.store.get_all_holdings()


@app.post("/portfolio/add", status_code=201)
async def add_holding(holding: Holding) -> Holding:
    store: PortfolioStore = app.state.store
    if await store.count_holdings() >= MAX_HOLDINGS:
        raise HTTPException(status_code=429, detail=f"portfolio limit of {MAX_HOLDINGS} holdings reached")

    await store.add_holding(holding)
    await app.state.ws_manager.track_ticker(holding.ticker)
    return holding


@app.delete("/portfolio/{ticker}", status_code=204, response_model=None)
async def remove_holding(ticker: str) -> None:
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z)")

    store: PortfolioStore = app.state.store
    if await store.get_holding(ticker) is None:
        raise HTTPException(status_code=404, detail=f"no holding for {ticker}")

    await store.remove_holding(ticker)
    await app.state.ws_manager.untrack_ticker(ticker)


@app.get("/news/{ticker}")
async def get_more_news(ticker: str, before: datetime | None = None, limit: int = 5) -> list[NewsItem]:
    """On-demand "load more" past what the 60s poll cycle already
    broadcast (news_service.py caps that at 5 per ticker per cycle).
    ``before`` is the published_at of the oldest item the client already
    has; omit it to get the most recent items not yet seen.
    """
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z)")
    limit = max(1, min(limit, 20))

    news_service: NewsService = app.state.news_service
    return await news_service.get_more_news(ticker, before, limit)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    manager: WebSocketManager = app.state.ws_manager
    await manager.connect(websocket)
    try:
        while True:
            # Clients don't send anything meaningful; this just detects
            # disconnects. receive_text() raises WebSocketDisconnect when
            # the client closes the connection.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
