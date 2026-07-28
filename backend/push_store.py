"""Redis-backed Web Push subscription storage.

No per-user concept in this single-tenant app — just "every browser
that's subscribed," mirroring watchlist_store.py's flat-membership
shape but keyed by endpoint (a push subscription's unique identifier,
assigned by the browser's push service) rather than ticker, and hashed
rather than a plain set since each subscription carries more than just
its own identity: the p256dh/auth encryption keys the browser generated
alongside it, needed to actually send a push.
"""
from __future__ import annotations

import json

import redis.asyncio as redis

SUBSCRIPTIONS_KEY = "push:subscriptions"


class PushStore:
    def __init__(self, redis_url: str):
        self._redis = redis.from_url(redis_url, decode_responses=True)

    async def close(self) -> None:
        await self._redis.aclose()

    async def add_subscription(self, endpoint: str, keys: dict) -> None:
        await self._redis.hset(SUBSCRIPTIONS_KEY, endpoint, json.dumps(keys))

    async def remove_subscription(self, endpoint: str) -> None:
        await self._redis.hdel(SUBSCRIPTIONS_KEY, endpoint)

    async def get_all_subscriptions(self) -> list[dict]:
        """Shape matches exactly what pywebpush.webpush's subscription_info
        parameter expects: {"endpoint": ..., "keys": {"p256dh": ...,
        "auth": ...}}.
        """
        raw = await self._redis.hgetall(SUBSCRIPTIONS_KEY)
        return [{"endpoint": endpoint, "keys": json.loads(keys_json)} for endpoint, keys_json in raw.items()]
