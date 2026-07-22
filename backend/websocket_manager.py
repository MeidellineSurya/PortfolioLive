"""Bridges Alpaca price ticks to connected frontend WebSocket clients.

Owns the one-Alpaca-connection-for-everyone invariant: individual tickers
are subscribed/unsubscribed on the shared ``AlpacaClient`` as holdings or
watchlist entries are added/removed, and every incoming quote is turned
into either a P&L-aware ``PriceUpdate`` (portfolio holdings) or a
``WatchlistPriceUpdate`` (watchlist-only tickers) broadcast to all
connected frontend clients.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import WebSocket

import metrics
from alpaca_client import AlpacaClient
from models import Holding, HoldingWithPrice, PriceUpdate, WatchlistItemWithPrice, WatchlistPriceUpdate
from portfolio_store import PortfolioStore
from watchlist_store import WatchlistStore

logger = logging.getLogger(__name__)

# Called with (ticker, previous_price, new_price) after every quote that
# has a previous price to compare against. Lets other services (price
# alerts, portfolio snapshots) react to ticks without WebSocketManager
# needing to know they exist — the same loosely-coupled callback shape
# already used for AlpacaClient's on_quote/get_tickers/on_batch.
QuoteListener = Callable[[str, float, float], Awaitable[None]]


class WebSocketManager:
    def __init__(
        self, alpaca_client: AlpacaClient, portfolio_store: PortfolioStore, watchlist_store: WatchlistStore
    ):
        self._alpaca = alpaca_client
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

    def add_quote_listener(self, listener: QuoteListener) -> None:
        self._quote_listeners.append(listener)

    def get_last_prices(self) -> dict[str, float]:
        return dict(self._last_prices)

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
            price = self._last_prices.get(holding.ticker)
            if price is None:
                enriched.append(HoldingWithPrice(**holding.model_dump()))
                continue
            position_value, position_pnl, position_pnl_pct = self._position_math(holding, price)
            enriched.append(
                HoldingWithPrice(
                    **holding.model_dump(),
                    price=round(price, 4),
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
            price = self._last_prices.get(ticker)
            if price is None:
                enriched.append(WatchlistItemWithPrice(ticker=ticker))
                continue
            prev_close = self._prev_close.get(ticker, price)
            change, change_pct = self._change_math(prev_close, price)
            enriched.append(
                WatchlistItemWithPrice(
                    ticker=ticker,
                    price=round(price, 4),
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

    # ---- portfolio <-> Alpaca subscription bridge -----------------------

    async def track_ticker(self, ticker: str) -> None:
        if ticker not in self._prev_close:
            prev_close = await self._alpaca.get_previous_close(ticker)
            if prev_close is not None:
                self._prev_close[ticker] = prev_close
        await self._alpaca.subscribe_quote(ticker)

    async def untrack_ticker(self, ticker: str) -> None:
        await self._alpaca.unsubscribe_quote(ticker)
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

        if holding is not None:
            position_value, position_pnl, position_pnl_pct = self._position_math(holding, price)
            update = PriceUpdate(
                ticker=ticker,
                price=round(price, 4),
                change=round(change, 4),
                change_pct=round(change_pct, 4),
                position_value=round(position_value, 2),
                position_pnl=round(position_pnl, 2),
                position_pnl_pct=round(position_pnl_pct, 4),
            )
            await self.broadcast(update.model_dump())
        else:
            watch_update = WatchlistPriceUpdate(
                ticker=ticker, price=round(price, 4), change=round(change, 4), change_pct=round(change_pct, 4)
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
