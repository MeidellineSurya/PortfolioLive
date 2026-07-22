"""Single-user JWT auth.

Credentials are bootstrapped from env vars into Redis on startup (once —
see bootstrap_user), not created via an open registration endpoint. An
unauthenticated "create the user" endpoint would be a way for anyone to
overwrite the single account; env-var bootstrap matches how every other
secret in this app already works (ALPACA_API_KEY etc.) and needs no new
onboarding flow for a single-user personal app.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import redis.asyncio as redis

ALGORITHM = "HS256"
TOKEN_TTL_HOURS = 24
AUTH_USERNAME_KEY = "auth:username"
AUTH_PASSWORD_HASH_KEY = "auth:password_hash"


class AuthService:
    def __init__(self, redis_url: str, secret_key: str):
        self._redis = redis.from_url(redis_url, decode_responses=True)
        self._secret_key = secret_key

    async def close(self) -> None:
        await self._redis.aclose()

    async def bootstrap_user(self, username: str, password: str) -> None:
        """Idempotent by design: only seeds credentials if none exist yet.
        Without that check, every backend restart would silently reset
        the password back to whatever's in AUTH_PASSWORD — including
        undoing a password someone rotated by editing Redis directly.
        """
        existing = await self._redis.get(AUTH_USERNAME_KEY)
        if existing is not None:
            return
        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.set(AUTH_USERNAME_KEY, username)
            pipe.set(AUTH_PASSWORD_HASH_KEY, password_hash)
            await pipe.execute()

    async def verify_login(self, username: str, password: str) -> bool:
        stored_username = await self._redis.get(AUTH_USERNAME_KEY)
        stored_hash = await self._redis.get(AUTH_PASSWORD_HASH_KEY)
        if stored_username is None or stored_hash is None or username != stored_username:
            return False
        return bcrypt.checkpw(password.encode(), stored_hash.encode())

    def create_token(self, username: str) -> str:
        payload = {"sub": username, "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS)}
        return jwt.encode(payload, self._secret_key, algorithm=ALGORITHM)

    def verify_token(self, token: str) -> str | None:
        try:
            payload = jwt.decode(token, self._secret_key, algorithms=[ALGORITHM])
        except jwt.PyJWTError:
            return None
        return payload.get("sub")
