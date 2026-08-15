import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest

from models import Holding
from websocket_manager import BROADCAST_THROTTLE_SECONDS, WebSocketManager


class FakePortfolioStore:
    def __init__(self, holding: Holding | None):
        self._holding = holding

    async def get_holding(self, ticker: str) -> Holding | None:
        return self._holding if self._holding and self._holding.ticker == ticker else None


class FakeWatchlistStore:
    async def has_ticker(self, ticker: str) -> bool:
        return False


@pytest.fixture
def manager():
    holding = Holding(ticker="AAPL", quantity=10, avg_cost=100)
    return WebSocketManager(
        alpaca_client=None,
        yahoo_client=None,
        portfolio_store=FakePortfolioStore(holding),
        watchlist_store=FakeWatchlistStore(),
    )


def test_rapid_ticks_broadcast_at_most_once_per_throttle_window(manager):
    async def run():
        with patch("websocket_manager.time.monotonic", side_effect=[0.0, 0.1, 0.2, 0.3]):
            manager.broadcast = AsyncMock()
            for price in (200.0, 200.5, 200.3, 200.4):
                await manager.on_quote("AAPL", price)

    asyncio.run(run())

    # All four ticks landed inside one throttle window, so only the first
    # was actually broadcast — but last_prices must still reflect the most
    # recent tick, not the one that happened to get broadcast.
    manager.broadcast.assert_awaited_once()
    assert manager.get_last_prices()["AAPL"] == 200.4


def test_a_tick_after_the_throttle_window_broadcasts_again(manager):
    async def run():
        with patch(
            "websocket_manager.time.monotonic",
            side_effect=[0.0, BROADCAST_THROTTLE_SECONDS + 0.01],
        ):
            manager.broadcast = AsyncMock()
            await manager.on_quote("AAPL", 200.0)
            await manager.on_quote("AAPL", 201.0)

    asyncio.run(run())

    assert manager.broadcast.await_count == 2


def test_throttled_ticks_still_reach_quote_listeners(manager):
    seen = []

    async def listener(ticker, previous_price, price):
        seen.append((ticker, previous_price, price))

    async def run():
        manager.add_quote_listener(listener)
        with patch("websocket_manager.time.monotonic", side_effect=[0.0, 0.1, 0.2]):
            manager.broadcast = AsyncMock()
            await manager.on_quote("AAPL", 200.0)
            await manager.on_quote("AAPL", 205.0)
            await manager.on_quote("AAPL", 195.0)

    asyncio.run(run())

    # Every tick after the first must still reach listeners (price alerts
    # rely on seeing every raw tick to detect a brief crossing), even
    # though only the first tick in this window was actually broadcast.
    assert seen == [("AAPL", 200.0, 205.0), ("AAPL", 205.0, 195.0)]


def test_on_quote_attaches_currency_derived_from_ticker_suffix():
    holding = Holding(ticker="BBCA.JK", quantity=10, avg_cost=6000)
    manager = WebSocketManager(
        alpaca_client=None,
        yahoo_client=None,
        portfolio_store=FakePortfolioStore(holding),
        watchlist_store=FakeWatchlistStore(),
    )

    async def run():
        manager.broadcast = AsyncMock()
        await manager.on_quote("BBCA.JK", 6275.0)

    asyncio.run(run())

    broadcast_message = manager.broadcast.await_args.args[0]
    assert broadcast_message["currency"] == "IDR"


def test_on_quote_includes_a_wall_clock_timestamp_on_broadcast_messages(manager):
    async def run():
        manager.broadcast = AsyncMock()
        await manager.on_quote("AAPL", 200.0)

    asyncio.run(run())

    broadcast_message = manager.broadcast.await_args.args[0]
    assert "timestamp" in broadcast_message
    # Round-trips through fromisoformat without raising — confirms it's a
    # real, parseable wall-clock timestamp, not the monotonic clock used
    # for throttle math (which has an arbitrary, non-wall-clock epoch).
    datetime.fromisoformat(broadcast_message["timestamp"])


def test_track_ticker_routes_to_the_client_matching_the_tickers_currency():
    class FakeClient:
        def __init__(self):
            self.subscribe_quote = AsyncMock()
            self.unsubscribe_quote = AsyncMock()
            self.get_previous_close = AsyncMock(return_value=None)

    alpaca_client = FakeClient()
    yahoo_client = FakeClient()
    manager = WebSocketManager(
        alpaca_client=alpaca_client,
        yahoo_client=yahoo_client,
        portfolio_store=FakePortfolioStore(None),
        watchlist_store=FakeWatchlistStore(),
    )

    async def run():
        await manager.track_ticker("AAPL")
        await manager.track_ticker("BBCA.JK")
        await manager.untrack_ticker("AAPL")
        await manager.untrack_ticker("BBCA.JK")

    asyncio.run(run())

    alpaca_client.subscribe_quote.assert_awaited_once_with("AAPL")
    alpaca_client.unsubscribe_quote.assert_awaited_once_with("AAPL")
    yahoo_client.subscribe_quote.assert_awaited_once_with("BBCA.JK")
    yahoo_client.unsubscribe_quote.assert_awaited_once_with("BBCA.JK")
