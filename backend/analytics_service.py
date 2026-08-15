"""Portfolio performance analytics: periodic snapshots + derived stats.

A snapshot is taken hourly (and once immediately on startup) and stored
in a Redis sorted set, scored by unix timestamp, so "give me the last N
days" is a cheap range query rather than scanning everything. Each
snapshot captures per-ticker price/value/pnl_pct alongside portfolio
totals — best/worst performer is a per-ticker question, not something
derivable from portfolio-level totals alone.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import redis.asyncio as redis

from models import (
    AnalyticsResponse,
    CurrencyTotals,
    HoldingSnapshot,
    PerformanceEntry,
    PortfolioSnapshot,
    currency_for_ticker,
)
from portfolio_store import PortfolioStore
from websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

SNAPSHOT_INTERVAL_SECONDS = 3600
SNAPSHOTS_KEY = "portfolio:snapshots"
SNAPSHOT_RETENTION_DAYS = 90
# "Best/worst performer" is defined as a fixed 7-day window regardless of
# whatever range the chart itself is asked for — it's part of the
# feature's definition, not a caller-supplied parameter.
PERFORMANCE_WINDOW_DAYS = 7


class AnalyticsService:
    def __init__(self, portfolio_store: PortfolioStore, ws_manager: WebSocketManager, redis_url: str):
        self._store = portfolio_store
        self._ws_manager = ws_manager
        # Dedicated connection, same reasoning as NewsService (commit 5):
        # this is its own concern (historical snapshots), not portfolio
        # CRUD, and not worth coupling to PortfolioStore's internals.
        self._redis = redis.from_url(redis_url, decode_responses=True)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._snapshot_loop())

    async def _snapshot_loop(self) -> None:
        while True:
            try:
                await self.snapshot_once()
            except Exception:
                logger.exception("portfolio snapshot failed")
            await asyncio.sleep(SNAPSHOT_INTERVAL_SECONDS)

    async def snapshot_once(self) -> PortfolioSnapshot | None:
        holdings = await self._store.get_all_holdings()
        if not holdings:
            return None

        last_prices = self._ws_manager.get_last_prices()
        prev_close = self._ws_manager.get_prev_close()
        holding_snapshots: dict[str, HoldingSnapshot] = {}
        # Accumulated per currency, not into one pair of scalars — a $
        # value and an Rp value can't be summed together without an FX
        # conversion this app deliberately doesn't do (see DECISION_LOG).
        value_by_currency: dict[str, float] = {}
        cost_basis_by_currency: dict[str, float] = {}

        for holding in holdings:
            # Falls back to the previous close the same way
            # enrich_holdings/enrich_watchlist do (websocket_manager.py) —
            # without this, a process restart landing outside market hours
            # (no live tick seen yet this process's lifetime) silently
            # dropped that ticker's *entire currency* from every hourly
            # snapshot taken until the market reopened, confirmed live: a
            # snapshot taken shortly after a restart had IDR holdings only,
            # USD ones missing outright, even though GET /portfolio was
            # already showing correct last-known USD prices via the same
            # fallback on the dashboard side.
            price = last_prices.get(holding.ticker, prev_close.get(holding.ticker))
            if price is None:
                # Genuinely never known — just added, or no live tick and
                # no prev_close fetched yet. Falling back to avg_cost
                # would misrepresent "unknown" as a real data point in
                # the history this powers.
                continue
            cost_basis = holding.avg_cost * holding.quantity
            value = price * holding.quantity
            pnl_pct = ((value - cost_basis) / cost_basis * 100) if cost_basis else 0.0
            holding_snapshots[holding.ticker] = HoldingSnapshot(
                price=price, value=round(value, 2), pnl_pct=round(pnl_pct, 4)
            )
            currency = currency_for_ticker(holding.ticker)
            value_by_currency[currency] = value_by_currency.get(currency, 0.0) + value
            cost_basis_by_currency[currency] = cost_basis_by_currency.get(currency, 0.0) + cost_basis

        if not holding_snapshots:
            return None

        totals: dict[str, CurrencyTotals] = {}
        for currency, value in value_by_currency.items():
            cost_basis = cost_basis_by_currency[currency]
            pnl = value - cost_basis
            pnl_pct = (pnl / cost_basis * 100) if cost_basis else 0.0
            totals[currency] = CurrencyTotals(
                total_value=round(value, 2), total_pnl=round(pnl, 2), total_pnl_pct=round(pnl_pct, 4)
            )

        now = datetime.now(timezone.utc)
        snapshot = PortfolioSnapshot(
            timestamp=now.isoformat(),
            totals=totals,
            holdings=holding_snapshots,
        )

        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.zadd(SNAPSHOTS_KEY, {snapshot.model_dump_json(): now.timestamp()})
            cutoff = (now - timedelta(days=SNAPSHOT_RETENTION_DAYS)).timestamp()
            pipe.zremrangebyscore(SNAPSHOTS_KEY, 0, cutoff)
            await pipe.execute()

        return snapshot

    async def get_analytics(self, days: int) -> AnalyticsResponse:
        now = datetime.now(timezone.utc)

        history = await self._history_since(now - timedelta(days=days))
        latest = history[-1] if history else None

        perf_history = await self._history_since(now - timedelta(days=PERFORMANCE_WINDOW_DAYS))
        best, worst = self._performance_window(perf_history)

        return AnalyticsResponse(
            totals=latest.totals if latest else {},
            history=history,
            best_performer_7d=best,
            worst_performer_7d=worst,
        )

    async def _history_since(self, since: datetime) -> list[PortfolioSnapshot]:
        raw = await self._redis.zrangebyscore(SNAPSHOTS_KEY, since.timestamp(), "+inf")
        return [PortfolioSnapshot.model_validate_json(item) for item in raw]

    @staticmethod
    def _performance_window(
        history: list[PortfolioSnapshot],
    ) -> tuple[PerformanceEntry | None, PerformanceEntry | None]:
        """Best/worst performer by price change % between the oldest and
        newest snapshot in the given window — recent momentum, not
        lifetime return since purchase (the P&L column already shows
        that). Needs at least two snapshots that both include the same
        ticker to compute a change.
        """
        if len(history) < 2:
            return None, None

        earliest, latest = history[0], history[-1]
        changes: list[PerformanceEntry] = []
        for ticker, latest_holding in latest.holdings.items():
            earliest_holding = earliest.holdings.get(ticker)
            if earliest_holding is None or earliest_holding.price == 0:
                continue
            change_pct = (latest_holding.price - earliest_holding.price) / earliest_holding.price * 100
            changes.append(PerformanceEntry(ticker=ticker, change_pct=round(change_pct, 4)))

        if not changes:
            return None, None

        best = max(changes, key=lambda entry: entry.change_pct)
        worst = min(changes, key=lambda entry: entry.change_pct)
        return best, worst
