"""FastAPI app entry point: REST routes + the /ws endpoint."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from alert_service import AlertService
from alert_store import AlertStore
from alpaca_client import AlpacaClient
from analytics_service import AnalyticsService
from auth import AuthService
from models import (
    TICKER_RE,
    AnalyticsResponse,
    Holding,
    HoldingWithPrice,
    LoginRequest,
    LoginResponse,
    NewsItem,
    PriceAlert,
    PriceAlertCreate,
    WatchlistAdd,
    WatchlistItem,
    WatchlistItemWithPrice,
)
from news_service import NewsService
from portfolio_store import PortfolioStore
from watchlist_store import WatchlistStore
from websocket_manager import WebSocketManager
from yahoo_client import YahooClient

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
MAX_WATCHLIST = 50

_bearer_scheme = HTTPBearer()


async def require_auth(
    request: Request, credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme)
) -> str:
    auth_service: AuthService = request.app.state.auth_service
    username = auth_service.verify_token(credentials.credentials)
    if username is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return username


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
    # Alpaca has no Indonesia coverage; .JK-suffixed tickers are polled
    # from Yahoo Finance instead (yahoo_client.py) but feed the exact
    # same on_quote callback, so WebSocketManager's tick-handling logic
    # doesn't need to branch on where a given tick came from.
    yahoo_client = YahooClient(on_quote=on_quote)
    watchlist_store = WatchlistStore(os.environ["REDIS_URL"])
    manager = WebSocketManager(alpaca_client, yahoo_client, store, watchlist_store)
    news_service = NewsService(
        alpaca_client=alpaca_client,
        yahoo_client=yahoo_client,
        portfolio_store=store,
        watchlist_store=watchlist_store,
        ws_manager=manager,
        groq_api_key=os.environ["GROQ_API_KEY"],
        redis_url=os.environ["REDIS_URL"],
    )
    alert_store = AlertStore(os.environ["REDIS_URL"])
    alert_service = AlertService(alert_store, manager)
    analytics_service = AnalyticsService(store, manager, os.environ["REDIS_URL"])
    auth_service = AuthService(os.environ["REDIS_URL"], os.environ["AUTH_SECRET_KEY"])

    # Threshold-crossing checks piggyback on every quote tick via the
    # same loosely-coupled listener hook WebSocketManager exposes for
    # exactly this — it doesn't need to import AlertService or know
    # alerts exist at all.
    manager.add_quote_listener(alert_service.check_and_trigger)

    app.state.store = store
    app.state.watchlist_store = watchlist_store
    app.state.alpaca_client = alpaca_client
    app.state.yahoo_client = yahoo_client
    app.state.ws_manager = manager
    app.state.news_service = news_service
    app.state.alert_service = alert_service
    app.state.analytics_service = analytics_service
    app.state.auth_service = auth_service

    alpaca_client.start()
    yahoo_client.start()
    try:
        await auth_service.bootstrap_user(os.environ["AUTH_USERNAME"], os.environ["AUTH_PASSWORD"])
        await manager.load_initial_holdings()
        await manager.load_initial_watchlist()
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
        await yahoo_client.stop()
        await news_service.stop()
        await store.close()
        await watchlist_store.close()
        await alert_store.close()
        await auth_service.close()


app = FastAPI(title="PortfolioLive API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Everything that touches portfolio/news/alerts/analytics data requires a
# valid token, applied at the router level rather than repeated as
# `dependencies=[Depends(require_auth)]` on each of the 8 routes below —
# a per-route opt-in is one route away from an accidental unauthenticated
# leak every time someone adds a new one; a router-level default makes
# "protected" the thing you'd have to opt *out* of instead.
protected = APIRouter(dependencies=[Depends(require_auth)])


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/metrics")
async def metrics_endpoint() -> Response:
    # Deliberately unauthenticated, same as /health — a Prometheus
    # scraper hitting this on a schedule shouldn't need a JWT any more
    # than Railway's health checker should.
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/auth/login")
async def login(body: LoginRequest) -> LoginResponse:
    auth_service: AuthService = app.state.auth_service
    if not await auth_service.verify_login(body.username, body.password):
        raise HTTPException(status_code=401, detail="invalid username or password")
    return LoginResponse(access_token=auth_service.create_token(body.username))


@protected.get("/portfolio", response_model_exclude_none=True)
async def get_portfolio() -> list[HoldingWithPrice]:
    # exclude_none means a holding with no known price yet omits those
    # fields from the JSON entirely, rather than sending explicit nulls —
    # matches how the frontend's PortfolioRow already treats "field
    # absent" as "no live data yet" (commit 7), so no frontend-side null
    # handling is needed for this to slot in cleanly.
    holdings = await app.state.store.get_all_holdings()
    return app.state.ws_manager.enrich_holdings(holdings)


@protected.post("/portfolio/add", status_code=201)
async def add_holding(holding: Holding) -> Holding:
    store: PortfolioStore = app.state.store
    if await store.count_holdings() >= MAX_HOLDINGS:
        raise HTTPException(status_code=429, detail=f"portfolio limit of {MAX_HOLDINGS} holdings reached")

    await store.add_holding(holding)
    await app.state.ws_manager.track_ticker(holding.ticker)
    # Buying something you were watching means you're no longer just
    # watching it — auto-migrate out of the watchlist so it doesn't show
    # up in both places. The underlying Alpaca subscription is untouched
    # (track_ticker above already ensured it exists); this only removes
    # the watchlist's own membership record.
    await app.state.watchlist_store.remove_ticker(holding.ticker)
    return holding


@protected.delete("/portfolio/{ticker}", status_code=204, response_model=None)
async def remove_holding(ticker: str) -> None:
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(
            status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z), optionally suffixed with .JK"
        )

    store: PortfolioStore = app.state.store
    if await store.get_holding(ticker) is None:
        raise HTTPException(status_code=404, detail=f"no holding for {ticker}")

    await store.remove_holding(ticker)
    await app.state.ws_manager.untrack_ticker(ticker)
    await app.state.alert_service.delete_alerts_for_ticker(ticker)


@protected.get("/watchlist", response_model_exclude_none=True)
async def get_watchlist() -> list[WatchlistItemWithPrice]:
    tickers = await app.state.watchlist_store.get_all_tickers()
    return app.state.ws_manager.enrich_watchlist(tickers)


@protected.post("/watchlist/add", status_code=201)
async def add_to_watchlist(item: WatchlistAdd) -> WatchlistItem:
    store: PortfolioStore = app.state.store
    watchlist_store: WatchlistStore = app.state.watchlist_store

    # Watching something you already own is confusing (it'd show up in
    # both the holdings table and the watchlist with no clear reason why)
    # and pointless (the portfolio table already has its live price).
    if await store.get_holding(item.ticker) is not None:
        raise HTTPException(status_code=400, detail=f"{item.ticker} is already in your portfolio")
    if await watchlist_store.count_tickers() >= MAX_WATCHLIST:
        raise HTTPException(status_code=429, detail=f"watchlist limit of {MAX_WATCHLIST} tickers reached")

    await watchlist_store.add_ticker(item.ticker)
    await app.state.ws_manager.track_ticker(item.ticker)
    return WatchlistItem(ticker=item.ticker)


@protected.delete("/watchlist/{ticker}", status_code=204, response_model=None)
async def remove_from_watchlist(ticker: str) -> None:
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(
            status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z), optionally suffixed with .JK"
        )

    watchlist_store: WatchlistStore = app.state.watchlist_store
    if not await watchlist_store.has_ticker(ticker):
        raise HTTPException(status_code=404, detail=f"{ticker} is not on your watchlist")

    await watchlist_store.remove_ticker(ticker)
    await app.state.ws_manager.untrack_ticker(ticker)
    await app.state.alert_service.delete_alerts_for_ticker(ticker)


@protected.get("/news/{ticker}")
async def get_more_news(ticker: str, before: datetime | None = None, limit: int = 5) -> list[NewsItem]:
    """On-demand "load more" past what the 60s poll cycle already
    broadcast (news_service.py caps that at 5 per ticker per cycle).
    ``before`` is the published_at of the oldest item the client already
    has; omit it to get the most recent items not yet seen.
    """
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(
            status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z), optionally suffixed with .JK"
        )
    limit = max(1, min(limit, 20))

    news_service: NewsService = app.state.news_service
    return await news_service.get_more_news(ticker, before, limit)


@protected.get("/alerts")
async def list_alerts() -> list[PriceAlert]:
    alert_service: AlertService = app.state.alert_service
    return await alert_service.list_alerts()


@protected.post("/alerts", status_code=201)
async def create_alert(alert: PriceAlertCreate) -> PriceAlert:
    # Alerts only ever get checked from inside WebSocketManager.on_quote
    # (via the quote-listener hook), which only fires for tickers actually
    # subscribed on Alpaca — driven by *either* portfolio holdings or
    # watchlist entries (websocket_manager.py's track_ticker doesn't care
    # which). This used to require the ticker be a holding specifically
    # (commit 15), noted then as "watchlist-style alerts would need their
    # own subscription lifecycle" — the watchlist feature now provides
    # exactly that, so the restriction is checked against both stores.
    store: PortfolioStore = app.state.store
    watchlist_store: WatchlistStore = app.state.watchlist_store
    is_held = await store.get_holding(alert.ticker) is not None
    is_watched = await watchlist_store.has_ticker(alert.ticker)
    if not is_held and not is_watched:
        raise HTTPException(status_code=400, detail=f"{alert.ticker} is not in your portfolio or watchlist")

    alert_service: AlertService = app.state.alert_service
    return await alert_service.create_alert(alert.ticker, alert.target_price)


@protected.delete("/alerts/{alert_id}", status_code=204, response_model=None)
async def delete_alert(alert_id: str) -> None:
    alert_service: AlertService = app.state.alert_service
    await alert_service.delete_alert(alert_id)


@protected.get("/analytics")
async def get_analytics(days: int = 30) -> AnalyticsResponse:
    days = max(1, min(days, 90))
    analytics_service: AnalyticsService = app.state.analytics_service
    return await analytics_service.get_analytics(days)


app.include_router(protected)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # Browsers' native WebSocket API can't set custom headers, so the
    # Authorization-header pattern the REST routes use isn't available
    # here — a `?token=` query param is the standard workaround. Checked
    # before accept() so an invalid/missing token never reaches
    # WebSocketManager at all — verified live that calling close() before
    # accept() makes uvicorn refuse the handshake with a plain HTTP 403,
    # not a WS close frame carrying this code; the `code=`/`reason=`
    # arguments are accepted but effectively unused on this path (there's
    # no accepted WS connection yet for a close frame to be sent over).
    auth_service: AuthService = websocket.app.state.auth_service
    token = websocket.query_params.get("token")
    username = auth_service.verify_token(token) if token else None
    if username is None:
        await websocket.close(code=4401, reason="unauthorized")
        return

    manager: WebSocketManager = websocket.app.state.ws_manager
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
