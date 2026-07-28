import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from digest_service import DigestService
from models import Holding


def make_service(holdings, watchlist, last_prices, prev_close):
    store = Mock()
    store.get_all_holdings = AsyncMock(return_value=holdings)
    watchlist_store = Mock()
    watchlist_store.get_all_tickers = AsyncMock(return_value=watchlist)
    ws_manager = Mock()
    ws_manager.get_last_prices = Mock(return_value=last_prices)
    ws_manager.get_prev_close = Mock(return_value=prev_close)
    push_service = Mock()
    push_service.notify_all = AsyncMock()
    service = DigestService(store, watchlist_store, ws_manager, push_service, digest_hour_utc=0)
    return service, push_service


def test_compute_moves_uses_prev_close_as_baseline():
    holdings = [Holding(ticker="AAPL", quantity=10, avg_cost=200)]
    service, _ = make_service(
        holdings=holdings,
        watchlist=["TSLA"],
        last_prices={"AAPL": 220.0, "TSLA": 90.0},
        prev_close={"AAPL": 200.0, "TSLA": 100.0},
    )

    moves = asyncio.run(service._compute_moves())

    assert moves["AAPL"] == pytest.approx(10.0)
    assert moves["TSLA"] == pytest.approx(-10.0)


def test_compute_moves_skips_tickers_with_no_price_or_baseline_yet():
    holdings = [
        Holding(ticker="AAPL", quantity=10, avg_cost=200),
        Holding(ticker="NVDA", quantity=5, avg_cost=100),
    ]
    service, _ = make_service(
        holdings=holdings,
        watchlist=[],
        last_prices={"AAPL": 220.0},  # NVDA has no live tick yet
        prev_close={"AAPL": 200.0, "NVDA": 100.0},
    )

    moves = asyncio.run(service._compute_moves())

    assert moves == {"AAPL": pytest.approx(10.0)}


def test_send_digest_does_not_push_when_nothing_to_report():
    service, push_service = make_service(holdings=[], watchlist=[], last_prices={}, prev_close={})

    asyncio.run(service.send_digest())

    push_service.notify_all.assert_not_called()


def test_send_digest_pushes_a_formatted_summary():
    holdings = [Holding(ticker="AAPL", quantity=10, avg_cost=200)]
    service, push_service = make_service(
        holdings=holdings,
        watchlist=["TSLA"],
        last_prices={"AAPL": 210.0, "TSLA": 80.0},
        prev_close={"AAPL": 200.0, "TSLA": 100.0},
    )

    asyncio.run(service.send_digest())

    push_service.notify_all.assert_awaited_once()
    _, kwargs = push_service.notify_all.call_args
    assert kwargs["title"] == "Daily digest"
    # Biggest absolute mover (TSLA, -20%) named before the smaller one
    # (AAPL, +5%) — distinct magnitudes so the ordering is unambiguous.
    assert kwargs["body"] == "TSLA -20.0%, AAPL +5.0%"


def test_format_body_summarises_beyond_the_named_limit():
    moves = {f"T{i}": float(i) for i in range(10)}

    body = DigestService._format_body(moves)

    assert "+4 more" in body
    assert body.count("%") == 6


def test_seconds_until_next_run_is_never_negative_or_absurdly_large():
    service, _ = make_service(holdings=[], watchlist=[], last_prices={}, prev_close={})

    seconds = service._seconds_until_next_run()

    assert 0 <= seconds <= 24 * 60 * 60
