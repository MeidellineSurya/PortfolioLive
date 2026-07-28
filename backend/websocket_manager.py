"""Bridges Alpaca/Yahoo price ticks to connected frontend WebSocket clients.

Owns the one-connection-per-source-for-everyone invariant: individual
tickers are subscribed/unsubscribed on whichever of the two shared price
clients matches the ticker's currency (US via AlpacaClient, IDX via
YahooClient — see models.currency_for_ticker) as holdings or watchlist
entries are added/removed, and every incoming quote is turned into
either a P&L-aware ``PriceUpdate`` (portfolio holdings) or a
``WatchlistPriceUpdate`` (watchlist-only tickers) broadcast to all
connected frontend clients. ``on_quote`` itself is source-agnostic — it
doesn't care which client called it, only which ticker/price it got.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

from fastapi import WebSocket

import metrics
from alpaca_client import AlpacaClient
from models import (
    Holding,
    HoldingWithPrice,
    PriceUpdate,
    WatchlistItemWithPrice,
    WatchlistPriceUpdate,
    currency_for_ticker,
)
from portfolio_store import PortfolioStore
from watchlist_store import WatchlistStore
from yahoo_client import YahooClient

logger = logging.getLogger(__name__)

# Alpaca's IEX quote stream can update a single symbol several times a
# second (real bid/ask movement, not a bug — verified live against the
# raw feed). Broadcasting every one of those to clients made sparkline
# charts look like they were "jumping a lot per second": each tick pushed
# a new point into the frontend's 20-point rolling window, so the visible
# window spanned only a few seconds of real time and any ordinary quote
# noise dominated it. Capping broadcasts to once per ticker per interval
# spreads that same 20-point window over a much longer, more meaningful
# span. This only gates *broadcasting* — see on_quote below, last_prices
# and quote listeners (price alerts) still see every raw tick, so a brief
# threshold crossing between broadcasts is never missed.
BROADCAST_THROTTLE_SECONDS = 1.0

# Called with (ticker, previous_price, new_price) after every quote that
# has a previous price to compare against. Lets other services (price
# alerts, portfolio snapshots) react to ticks without WebSocketManager
# needing to know they exist — the same loosely-coupled callback shape
# already used for AlpacaClient's on_quote/get_tickers/on_batch.
QuoteListener = Callable[[str, float, float], Awaitable[None]]


class WebSocketManager:
    def __init__(
        self,
        alpaca_client: AlpacaClient,
        yahoo_client: YahooClient,
        portfolio_store: PortfolioStore,
        watchlist_store: WatchlistStore,
    ):
        self._alpaca = alpaca_client
        self._yahoo = yahoo_client
        self._store = portfolio_store
        self._watchlist = watchlist_store
        self._clients: set[WebSocket] = set()
        # Previous close is fetched once per ticker (not per tick) and kept
        # in memory for the life of the process — see decision log for why
        # day-rollover refresh is out of scope.
        self._prev_close: dict[str, float] = {}
        # Last price seen per ticker — this is new state, not previously
        # tracked anywhere: on_quote used to compute a PriceUpdate and
        # broadcast it without remembering it afterwards. Needed by both
        # price alerts (to detect a threshold *crossing*, not just "price
        # is currently past it") and portfolio snapshots (analytics needs
        # to know "what's this holding worth right now" outside of a tick
        # handler).
        self._last_prices: dict[str, float] = {}
        self._quote_listeners: list[QuoteListener] = []
        self._last_broadcast_at: dict[str, float] = {}

    def add_quote_listener(self, listener: QuoteListener) -> None:
        self._quote_listeners.append(listener)

    def get_last_prices(self) -> dict[str, float]:
        return dict(self._last_prices)

    def get_prev_close(self) -> dict[str, float]:
        """Exposed for DigestService — the same per-ticker baseline
        already used to compute the change/change_pct fields on every
        live quote update, so "today's move" for the digest is
        derived from the exact same reference point the rest of the
        app already shows, not recomputed independently.
        """
        return dict(self._prev_close)

    def enrich_holdings(self, holdings: list[Holding]) -> list[HoldingWithPrice]:
        """Attaches last-known price/value/P&L to each holding, for
        GET /portfolio. Without this, a freshly-loaded page (or a page
        loaded while the market's closed, before this process has seen a
        single tick) shows blank placeholders until the *next* live tick
        arrives, even if this process already knows the last real price
        from earlier — e.g. from when the market was open earlier today.
        Holdings with no known price (just added, or never ticked this
        process's lifetime) get `None` fields, same as a row that hasn't
        received its first WebSocket tick yet.
        """
        enriched = []
        for holding in holdings:
            currency = currency_for_ticker(holding.ticker)
            price = self._last_prices.get(holding.ticker)
            if price is None:
                enriched.append(HoldingWithPrice(**holding.model_dump(), currency=currency))
                continue
            position_value, position_pnl, position_pnl_pct = self._position_math(holding, price)
            enriched.append(
                HoldingWithPrice(
                    **holding.model_dump(),
                    price=round(price, 4),
                    currency=currency,
                    position_value=round(position_value, 2),
                    position_pnl=round(position_pnl, 2),
                    position_pnl_pct=round(position_pnl_pct, 4),
                )
            )
        return enriched

    def enrich_watchlist(self, tickers: list[str]) -> list[WatchlistItemWithPrice]:
        """GET /watchlist's equivalent of enrich_holdings — same "show the
        last-known price on load instead of blank" reasoning, just with no
        P&L fields to compute (a watchlist ticker has no quantity/avg_cost).
        """
        enriched = []
        for ticker in tickers:
            currency = currency_for_ticker(ticker)
            price = self._last_prices.get(ticker)
            if price is None:
                enriched.append(WatchlistItemWithPrice(ticker=ticker, currency=currency))
                continue
            prev_close = self._prev_close.get(ticker, price)
            change, change_pct = self._change_math(prev_close, price)
            enriched.append(
                WatchlistItemWithPrice(
                    ticker=ticker,
                    price=round(price, 4),
                    currency=currency,
                    change=round(change, 4),
                    change_pct=round(change_pct, 4),
                )
            )
        return enriched

    @staticmethod
    def _position_math(holding: Holding, price: float) -> tuple[float, float, float]:
        cost_basis = holding.avg_cost * holding.quantity
        position_value = price * holding.quantity
        position_pnl = position_value - cost_basis
        position_pnl_pct = (position_pnl / cost_basis * 100) if cost_basis else 0.0
        return position_value, position_pnl, position_pnl_pct

    @staticmethod
    def _change_math(prev_close: float, price: float) -> tuple[float, float]:
        change = price - prev_close
        change_pct = (change / prev_close * 100) if prev_close else 0.0
        return change, change_pct

    # ---- frontend client management ------------------------------------

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.add(websocket)
        metrics.active_websocket_connections.set(len(self._clients))

    def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)
        metrics.active_websocket_connections.set(len(self._clients))

    async def broadcast(self, message: dict) -> None:
        if not self._clients:
            return
        dead: list[WebSocket] = []
        for client in self._clients:
            try:
                await client.send_json(message)
            except Exception:
                dead.append(client)
        for client in dead:
            self.disconnect(client)

    # ---- portfolio <-> price-client subscription bridge ------------------

    def _client_for(self, ticker: str) -> AlpacaClient | YahooClient:
        return self._yahoo if currency_for_ticker(ticker) == "IDR" else self._alpaca

    async def track_ticker(self, ticker: str) -> None:
        client = self._client_for(ticker)
        if ticker not in self._prev_close:
            prev_close = await client.get_previous_close(ticker)
            if prev_close is not None:
                self._prev_close[ticker] = prev_close
        await client.subscribe_quote(ticker)

    async def untrack_ticker(self, ticker: str) -> None:
        await self._client_for(ticker).unsubscribe_quote(ticker)
        self._prev_close.pop(ticker, None)

    async def load_initial_holdings(self) -> None:
        holdings = await self._store.get_all_holdings()
        for holding in holdings:
            await self.track_ticker(holding.ticker)

    async def load_initial_watchlist(self) -> None:
        tickers = await self._watchlist.get_all_tickers()
        for ticker in tickers:
            await self.track_ticker(ticker)

    # ---- Alpaca quote callback (registered as AlpacaClient's on_quote) --

    async def on_quote(self, ticker: str, price: float) -> None:
        holding = await self._store.get_holding(ticker)
        # A ticker can be a portfolio holding, a watchlist entry, or
        # (transiently) neither — removed from both after subscribing but
        # before the unsubscribe round trip completed, in which case the
        # tick is dropped. It's never checked as *both*: POST /portfolio/add
        # and POST /watchlist/add each guard against the ticker already
        # being in the other list, so this is a genuine either/or, not a
        # simplification that ignores a real overlap case.
        is_watched = holding is None and await self._watchlist.has_ticker(ticker)
        if holding is None and not is_watched:
            return

        prev_close = self._prev_close.get(ticker, price)
        change, change_pct = self._change_math(prev_close, price)
        currency = currency_for_ticker(ticker)

        now = time.monotonic()
        last_broadcast = self._last_broadcast_at.get(ticker)
        if last_broadcast is None or now - last_broadcast >= BROADCAST_THROTTLE_SECONDS:
            self._last_broadcast_at[ticker] = now
            if holding is not None:
                position_value, position_pnl, position_pnl_pct = self._position_math(holding, price)
                update = PriceUpdate(
                    ticker=ticker,
                    price=round(price, 4),
                    currency=currency,
                    change=round(change, 4),
                    change_pct=round(change_pct, 4),
                    position_value=round(position_value, 2),
                    position_pnl=round(position_pnl, 2),
                    position_pnl_pct=round(position_pnl_pct, 4),
                )
                await self.broadcast(update.model_dump())
            else:
                watch_update = WatchlistPriceUpdate(
                    ticker=ticker,
                    price=round(price, 4),
                    currency=currency,
                    change=round(change, 4),
                    change_pct=round(change_pct, 4),
                )
                await self.broadcast(watch_update.model_dump())

        previous_price = self._last_prices.get(ticker)
        self._last_prices[ticker] = price
        # No previous price means this is the first tick this process has
        # ever seen for the ticker — nothing to compare against yet, so
        # there's no "crossing" to detect (see AlertService, which is the
        # only current listener and needs exactly this guarantee). This
        # applies identically to watchlist tickers now — an alert can be
        # set on either kind (main.py's create_alert checks both stores).
        if previous_price is not None:
            for listener in self._quote_listeners:
                try:
                    await listener(ticker, previous_price, price)
                except Exception:
                    logger.exception("quote listener failed for %s", ticker)
