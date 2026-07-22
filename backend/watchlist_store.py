"""Redis-backed watchlist state — tickers tracked for price/news but not
owned. Simpler than PortfolioStore: there's no quantity/avg_cost per
ticker, just membership, so a single Redis set is enough (no per-ticker
hash needed).
"""
from __future__ import annotations

import redis.asyncio as redis

WATCHLIST_KEY = "watchlist:tickers"


class WatchlistStore:
    def __init__(self, redis_url: str):
        self._redis = redis.from_url(redis_url, decode_responses=True)

    async def close(self) -> None:
        await self._redis.aclose()

    async def add_ticker(self, ticker: str) -> None:
        await self._redis.sadd(WATCHLIST_KEY, ticker)

    async def remove_ticker(self, ticker: str) -> None:
        await self._redis.srem(WATCHLIST_KEY, ticker)

    async def has_ticker(self, ticker: str) -> bool:
        return bool(await self._redis.sismember(WATCHLIST_KEY, ticker))

    async def get_all_tickers(self) -> list[str]:
        return list(await self._redis.smembers(WATCHLIST_KEY))

    async def count_tickers(self) -> int:
        return await self._redis.scard(WATCHLIST_KEY)
