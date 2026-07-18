"""Redis-backed portfolio state.

Each holding is stored as a Redis hash at key ``portfolio:{ticker}`` with
fields ``quantity`` and ``avg_cost``. The set of tracked tickers is also
kept at ``portfolio:tickers`` (a Redis set) so we can enumerate holdings
without a KEYS scan.
"""
from __future__ import annotations

import redis.asyncio as redis

from models import Holding

TICKERS_KEY = "portfolio:tickers"


def _holding_key(ticker: str) -> str:
    return f"portfolio:{ticker}"


class PortfolioStore:
    def __init__(self, redis_url: str):
        self._redis = redis.from_url(redis_url, decode_responses=True)

    async def close(self) -> None:
        await self._redis.aclose()

    async def add_holding(self, holding: Holding) -> None:
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.hset(
                _holding_key(holding.ticker),
                mapping={"quantity": holding.quantity, "avg_cost": holding.avg_cost},
            )
            pipe.sadd(TICKERS_KEY, holding.ticker)
            await pipe.execute()

    async def remove_holding(self, ticker: str) -> None:
        ticker = ticker.strip().upper()
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.delete(_holding_key(ticker))
            pipe.srem(TICKERS_KEY, ticker)
            await pipe.execute()

    async def get_holding(self, ticker: str) -> Holding | None:
        data = await self._redis.hgetall(_holding_key(ticker.strip().upper()))
        if not data:
            return None
        return Holding(ticker=ticker, quantity=float(data["quantity"]), avg_cost=float(data["avg_cost"]))

    async def get_all_holdings(self) -> list[Holding]:
        tickers = await self._redis.smembers(TICKERS_KEY)
        if not tickers:
            return []
        holdings: list[Holding] = []
        for ticker in tickers:
            data = await self._redis.hgetall(_holding_key(ticker))
            if data:
                holdings.append(
                    Holding(ticker=ticker, quantity=float(data["quantity"]), avg_cost=float(data["avg_cost"]))
                )
        return holdings

    async def count_holdings(self) -> int:
        return await self._redis.scard(TICKERS_KEY)
