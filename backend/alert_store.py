"""Redis-backed price alert state.

Mirrors portfolio_store.py's shape: a hash per alert (`alert:{id}`) plus
index sets — one for "all alerts" (listing) and one per ticker (so
AlertService can look up "which alerts care about this ticker" on every
tick without scanning every alert in existence).
"""
from __future__ import annotations

import uuid

import redis.asyncio as redis

from models import PriceAlert

ALL_ALERTS_KEY = "alerts:all"


def _alert_key(alert_id: str) -> str:
    return f"alert:{alert_id}"


def _by_ticker_key(ticker: str) -> str:
    return f"alerts:by_ticker:{ticker}"


class AlertStore:
    def __init__(self, redis_url: str):
        self._redis = redis.from_url(redis_url, decode_responses=True)

    async def close(self) -> None:
        await self._redis.aclose()

    async def create_alert(self, ticker: str, target_price: float) -> PriceAlert:
        alert = PriceAlert(id=str(uuid.uuid4()), ticker=ticker, target_price=target_price)
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.hset(
                _alert_key(alert.id),
                mapping={
                    "ticker": alert.ticker,
                    "target_price": alert.target_price,
                    "triggered": int(alert.triggered),
                },
            )
            pipe.sadd(ALL_ALERTS_KEY, alert.id)
            pipe.sadd(_by_ticker_key(ticker), alert.id)
            await pipe.execute()
        return alert

    async def delete_alert(self, alert_id: str) -> None:
        alert = await self.get_alert(alert_id)
        if alert is None:
            return
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.delete(_alert_key(alert_id))
            pipe.srem(ALL_ALERTS_KEY, alert_id)
            pipe.srem(_by_ticker_key(alert.ticker), alert_id)
            await pipe.execute()

    async def mark_triggered(self, alert_id: str) -> None:
        await self._redis.hset(_alert_key(alert_id), "triggered", 1)

    async def get_alert(self, alert_id: str) -> PriceAlert | None:
        data = await self._redis.hgetall(_alert_key(alert_id))
        if not data:
            return None
        return self._to_alert(alert_id, data)

    async def list_alerts(self) -> list[PriceAlert]:
        ids = await self._redis.smembers(ALL_ALERTS_KEY)
        return [alert for alert_id in ids if (alert := await self.get_alert(alert_id)) is not None]

    async def list_alerts_for_ticker(self, ticker: str) -> list[PriceAlert]:
        ids = await self._redis.smembers(_by_ticker_key(ticker))
        return [alert for alert_id in ids if (alert := await self.get_alert(alert_id)) is not None]

    @staticmethod
    def _to_alert(alert_id: str, data: dict) -> PriceAlert:
        return PriceAlert(
            id=alert_id,
            ticker=data["ticker"],
            target_price=float(data["target_price"]),
            triggered=bool(int(data["triggered"])),
        )
