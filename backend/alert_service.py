"""Price alert threshold-crossing detection.

Registered as a quote listener on WebSocketManager (see
websocket_manager.py's QuoteListener) — checked on every tick that has a
previous price to compare against, so a *crossing* can be detected rather
than just "the price currently happens to be past the threshold" (which
would re-fire on every subsequent tick instead of once).
"""
from __future__ import annotations

import asyncio
import logging

from alert_store import AlertStore
from models import PriceAlert, PriceAlertTriggered
from push_service import PushService
from websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)


class AlertService:
    def __init__(self, alert_store: AlertStore, ws_manager: WebSocketManager, push_service: PushService):
        self._store = alert_store
        self._ws_manager = ws_manager
        self._push_service = push_service
        # asyncio's own docs warn that a task with no live reference can
        # be garbage-collected mid-execution — this set exists purely to
        # hold one until it's done, then self-discards via the done
        # callback. Not a task registry for any other purpose.
        self._pending_push_tasks: set[asyncio.Task] = set()

    async def create_alert(self, ticker: str, target_price: float) -> PriceAlert:
        return await self._store.create_alert(ticker, target_price)

    async def list_alerts(self) -> list[PriceAlert]:
        return await self._store.list_alerts()

    async def delete_alerts_for_ticker(self, ticker: str) -> None:
        """Called when a holding is removed (main.py's DELETE
        /portfolio/{ticker}). Without this, an alert for a removed
        holding would never fire again (on_quote only checks tickers
        still subscribed) but would sit in the list forever anyway,
        looking active.
        """
        alerts = await self._store.list_alerts_for_ticker(ticker)
        for alert in alerts:
            await self._store.delete_alert(alert.id)

    async def delete_alert(self, alert_id: str) -> None:
        await self._store.delete_alert(alert_id)

    async def check_and_trigger(self, ticker: str, previous_price: float, price: float) -> None:
        """The WebSocketManager quote listener (wired in main.py). One-shot
        per alert: an alert created *after* a price has already crossed
        its target won't retroactively fire, since there's no "previous
        tick below the target" for it to compare against — it'll fire
        normally the next time the price actually crosses again.
        """
        alerts = await self._store.list_alerts_for_ticker(ticker)
        for alert in alerts:
            if alert.triggered:
                continue
            direction = self._crossed(previous_price, price, alert.target_price)
            if direction is None:
                continue

            await self._store.mark_triggered(alert.id)
            triggered = PriceAlertTriggered(
                id=alert.id,
                ticker=ticker,
                target_price=alert.target_price,
                price=price,
                direction=direction,
            )
            await self._ws_manager.broadcast(triggered.model_dump())
            # Fire-and-forget: this runs on the same hot path as every
            # live quote tick (check_and_trigger is a WebSocketManager
            # quote listener), so a slow or unreachable push endpoint
            # must never delay processing the next tick. PushService
            # itself never raises — a task exception here would only
            # ever come from something unexpected, not a normal push
            # failure, so it's left unhandled rather than swallowed.
            task = asyncio.create_task(
                self._push_service.notify_all(
                    title=f"{ticker} crossed {direction} {alert.target_price:g}",
                    body=f"Now at {price:g}",
                )
            )
            self._pending_push_tasks.add(task)
            task.add_done_callback(self._pending_push_tasks.discard)

    @staticmethod
    def _crossed(previous_price: float, price: float, target: float) -> str | None:
        if previous_price < target <= price:
            return "above"
        if previous_price > target >= price:
            return "below"
        return None
