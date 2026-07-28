"""Web Push notification sending.

VAPID (Voluntary Application Server Identification) is how this server
proves to a browser's push service that it's the same server the
browser originally subscribed to — generated once (see .env.example)
and configured via VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_CLAIMS_EMAIL.
Silently no-ops (logged once, at startup) if unconfigured, rather than
requiring every local dev setup to have real push credentials just to
run the app.
"""
from __future__ import annotations

import asyncio
import json
import logging

from pywebpush import WebPushException, webpush

from push_store import PushStore

logger = logging.getLogger(__name__)


class PushService:
    def __init__(
        self,
        push_store: PushStore,
        vapid_public_key: str | None,
        vapid_private_key: str | None,
        vapid_claims_email: str | None,
    ):
        self._store = push_store
        self._private_key = vapid_private_key
        self._claims_email = vapid_claims_email
        self._configured = bool(vapid_public_key and vapid_private_key and vapid_claims_email)
        if not self._configured:
            logger.warning("VAPID keys not configured — push notifications are disabled")

    async def notify_all(self, title: str, body: str, url: str = "/") -> None:
        """Sends to every stored subscription concurrently. Callers on a
        hot path (AlertService.check_and_trigger runs on every live tick)
        should wrap this in asyncio.create_task rather than awaiting it
        directly — a slow or unreachable push endpoint must never delay
        quote processing. Never raises: each subscription's failure is
        caught and logged (or the subscription removed) independently.
        """
        if not self._configured:
            return
        subscriptions = await self._store.get_all_subscriptions()
        if not subscriptions:
            return
        payload = json.dumps({"title": title, "body": body, "url": url})
        await asyncio.gather(*(self._send_one(sub, payload) for sub in subscriptions))

    async def _send_one(self, subscription: dict, payload: str) -> None:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info=subscription,
                data=payload,
                vapid_private_key=self._private_key,
                vapid_claims={"sub": f"mailto:{self._claims_email}"},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                # The browser's push service itself confirms this
                # subscription no longer exists (uninstalled, permission
                # revoked, etc.) — remove it rather than retrying forever
                # on every future alert/digest.
                await self._store.remove_subscription(subscription["endpoint"])
            else:
                logger.exception("push send failed for %s", subscription["endpoint"])
        except Exception:
            logger.exception("push send failed for %s", subscription["endpoint"])
