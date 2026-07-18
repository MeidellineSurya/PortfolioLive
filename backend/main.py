"""FastAPI app entry point: REST routes + the /ws endpoint."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from alpaca_client import AlpacaClient
from models import Holding, TICKER_RE
from portfolio_store import PortfolioStore
from websocket_manager import WebSocketManager

load_dotenv()

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

    app.state.store = store
    app.state.alpaca_client = alpaca_client
    app.state.ws_manager = manager

    alpaca_client.start()
    await manager.load_initial_holdings()

    yield

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


@app.delete("/portfolio/{ticker}", status_code=204)
async def remove_holding(ticker: str) -> None:
    ticker = ticker.strip().upper()
    if not TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="ticker must be 1-5 uppercase letters (A-Z)")

    store: PortfolioStore = app.state.store
    if await store.get_holding(ticker) is None:
        raise HTTPException(status_code=404, detail=f"no holding for {ticker}")

    await store.remove_holding(ticker)
    await app.state.ws_manager.untrack_ticker(ticker)


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
