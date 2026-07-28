"""Daily digest — a scheduled push notification summarising today's price
moves across every tracked ticker (holdings + watchlist).

Deliberately price-moves-only, not news: news broadcasts are ephemeral
(news_service.py only keeps a dedup id set, no durable "what happened
today" log), so a real news digest would need new persistent storage —
out of scope here, a possible v2 later rather than a half-built inclusion
now.

Same background-loop shape as every other scheduled task in this
codebase (AlpacaClient._poll_news_forever, NewsService's Yahoo news
loop): sleep until the next scheduled time, fire, repeat, with the whole
body wrapped in try/except so one bad cycle can't kill the loop.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from portfolio_store import PortfolioStore
from push_service import PushService
from watchlist_store import WatchlistStore
from websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

# Number of tickers' worth of detail to name explicitly in the
# notification body before summarising the rest — a push notification
# body is small; a 15-holding portfolio listed in full would be
# unreadable, not more informative.
MAX_TICKERS_NAMED = 6


class DigestService:
    def __init__(
        self,
        portfolio_store: PortfolioStore,
        watchlist_store: WatchlistStore,
        ws_manager: WebSocketManager,
        push_service: PushService,
        digest_hour_utc: int,
    ):
        self._store = portfolio_store
        self._watchlist = watchlist_store
        self._ws_manager = ws_manager
        self._push_service = push_service
        self._digest_hour_utc = digest_hour_utc
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run_forever(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._seconds_until_next_run())
                await self.send_digest()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("daily digest cycle failed")

    def _seconds_until_next_run(self) -> float:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=self._digest_hour_utc, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        return (next_run - now).total_seconds()

    async def send_digest(self) -> None:
        """Also callable directly (not just from the schedule loop) — a
        manual trigger for verification without waiting for the actual
        scheduled hour.
        """
        moves = await self._compute_moves()
        if not moves:
            return
        await self._push_service.notify_all(title="Daily digest", body=self._format_body(moves))

    async def _compute_moves(self) -> dict[str, float]:
        holdings = await self._store.get_all_holdings()
        watchlist = await self._watchlist.get_all_tickers()
        tickers = {h.ticker for h in holdings} | set(watchlist)

        last_prices = self._ws_manager.get_last_prices()
        prev_close = self._ws_manager.get_prev_close()

        moves: dict[str, float] = {}
        for ticker in tickers:
            price = last_prices.get(ticker)
            baseline = prev_close.get(ticker)
            if price is None or not baseline:
                continue
            moves[ticker] = (price - baseline) / baseline * 100
        return moves

    @staticmethod
    def _format_body(moves: dict[str, float]) -> str:
        # Biggest absolute movers first — the ones actually worth naming
        # in a small notification body.
        ordered = sorted(moves.items(), key=lambda item: abs(item[1]), reverse=True)
        named = ordered[:MAX_TICKERS_NAMED]
        parts = [f"{ticker} {change_pct:+.1f}%" for ticker, change_pct in named]
        remainder = len(ordered) - len(named)
        if remainder > 0:
            parts.append(f"+{remainder} more")
        return ", ".join(parts)
