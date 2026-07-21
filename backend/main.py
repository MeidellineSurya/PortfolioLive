"""FastAPI app entry point: REST routes + the /ws endpoint."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from alert_service import AlertService
from alert_store import AlertStore
from alpaca_client import AlpacaClient
from analytics_service import AnalyticsService
from models import (
    TICKER_RE,
    AnalyticsResponse,
    Holding,
    HoldingWithPrice,
    NewsItem,
    PriceAlert,
    PriceAlertCreate,
)
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
    alert_store = AlertStore(os.environ["REDIS_URL"])
    alert_service = AlertService(alert_store, manager)
    analytics_service = AnalyticsService(store, manager, os.environ["REDIS_URL"])

    # Threshold-crossing checks piggyback on every quote tick via the
    # same loosely-coupled listener hook WebSocketManager exposes for
    # exactly this — it doesn't need to import AlertService or know
    # alerts exist at all.
    manager.add_quote_listener(alert_service.check_and_trigger)

    app.state.store = store
    app.state.alpaca_client = alpaca_client
    app.state.ws_manager = manager
    app.state.news_service = news_service
    app.state.alert_service = alert_service
    app.state.analytics_service = analytics_service

    alpaca_client.start()
    try:
        await manager.load_initial_holdings()
        news_service.start()
        analytics_service.start()
        yield
    finally:
        # Alpaca allows exactly one active stream connection per account —
        # if anything after start() (Redis, news setup) raises, skipping
        # this leaves that connection open with nothing left to close it,
        # locking out every subsequent start until Alpaca's own server-side
        # timeout eventually notices the client is gone.
        await alpaca_client.stop()
        await store.close()
        await alert_store.close()


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


@app.get("/portfolio", response_model_exclude_none=True)
async def get_portfolio() -> list[HoldingWithPrice]:
    # exclude_none means a holding with no known price yet omits those
    # fields from the JSON entirely, rather than sending explicit nulls —
    # matches how the frontend's PortfolioRow already treats "field
    # absent" as "no live data yet" (commit 7), so no frontend-side null
    # handling is needed for this to slot in cleanly.
    holdings = await app.state.store.get_all_holdings()
    return app.state.ws_manager.enrich_holdings(holdings)


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
    await app.state.alert_service.delete_alerts_for_ticker(ticker)


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


@app.get("/alerts")
async def list_alerts() -> list[PriceAlert]:
    alert_service: AlertService = app.state.alert_service
    return await alert_service.list_alerts()


@app.post("/alerts", status_code=201)
async def create_alert(alert: PriceAlertCreate) -> PriceAlert:
    # Alerts only ever get checked from inside WebSocketManager.on_quote
    # (via the quote-listener hook), which only fires for tickers actually
    # subscribed on Alpaca — and that subscription is driven entirely by
    # portfolio holdings (track_ticker/untrack_ticker). An alert for a
    # ticker you don't hold would never receive a tick to compare against
    # and would just sit forever, silently dead. Supporting watchlist-style
    # alerts (not-yet-owned tickers) would mean giving alerts their own
    # subscription lifecycle, independent of holdings — a bigger change
    # than this feature asked for.
    store: PortfolioStore = app.state.store
    if await store.get_holding(alert.ticker) is None:
        raise HTTPException(status_code=400, detail=f"{alert.ticker} is not in your portfolio")

    alert_service: AlertService = app.state.alert_service
    return await alert_service.create_alert(alert.ticker, alert.target_price)


@app.delete("/alerts/{alert_id}", status_code=204, response_model=None)
async def delete_alert(alert_id: str) -> None:
    alert_service: AlertService = app.state.alert_service
    await alert_service.delete_alert(alert_id)


@app.get("/analytics")
async def get_analytics(days: int = 30) -> AnalyticsResponse:
    days = max(1, min(days, 90))
    analytics_service: AnalyticsService = app.state.analytics_service
    return await analytics_service.get_analytics(days)


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
