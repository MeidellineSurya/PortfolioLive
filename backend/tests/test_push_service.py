import asyncio
from unittest.mock import AsyncMock, Mock, patch

from pywebpush import WebPushException

from push_service import PushService

SUBSCRIPTION = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "key1", "auth": "key2"}}


def make_service(configured=True):
    store = Mock()
    store.get_all_subscriptions = AsyncMock(return_value=[SUBSCRIPTION])
    store.remove_subscription = AsyncMock()
    if configured:
        service = PushService(
            store, vapid_public_key="pub", vapid_private_key="priv", vapid_claims_email="a@b.com"
        )
    else:
        service = PushService(store, vapid_public_key=None, vapid_private_key=None, vapid_claims_email=None)
    return service, store


def test_notify_all_noops_when_not_configured():
    service, store = make_service(configured=False)

    async def run():
        with patch("push_service.webpush") as mock_webpush:
            await service.notify_all(title="t", body="b")
            return mock_webpush

    mock_webpush = asyncio.run(run())
    store.get_all_subscriptions.assert_not_called()
    mock_webpush.assert_not_called()


def test_notify_all_noops_when_no_subscriptions():
    store = Mock()
    store.get_all_subscriptions = AsyncMock(return_value=[])
    service = PushService(store, vapid_public_key="pub", vapid_private_key="priv", vapid_claims_email="a@b")

    async def run():
        with patch("push_service.webpush") as mock_webpush:
            await service.notify_all(title="t", body="b")
            return mock_webpush

    mock_webpush = asyncio.run(run())
    mock_webpush.assert_not_called()


def test_notify_all_sends_to_every_subscription():
    service, store = make_service()

    async def run():
        with patch("push_service.webpush") as mock_webpush:
            await service.notify_all(title="TSLA crossed above 250", body="Now at 251")
            return mock_webpush

    mock_webpush = asyncio.run(run())
    mock_webpush.assert_called_once()
    _, kwargs = mock_webpush.call_args
    assert kwargs["subscription_info"] == SUBSCRIPTION
    assert kwargs["vapid_private_key"] == "priv"
    assert kwargs["vapid_claims"] == {"sub": "mailto:a@b.com"}
    assert '"title": "TSLA crossed above 250"' in kwargs["data"]


def test_expired_subscription_is_removed_not_retried():
    service, store = make_service()
    dead_response = Mock(status_code=410)

    async def run():
        with patch("push_service.webpush", side_effect=WebPushException("gone", response=dead_response)):
            await service.notify_all(title="t", body="b")

    asyncio.run(run())
    store.remove_subscription.assert_awaited_once_with(SUBSCRIPTION["endpoint"])


def test_other_push_failures_do_not_remove_the_subscription():
    service, store = make_service()
    server_error_response = Mock(status_code=500)

    async def run():
        exc = WebPushException("oops", response=server_error_response)
        with patch("push_service.webpush", side_effect=exc):
            # Must not raise — notify_all is called fire-and-forget from
            # AlertService's hot path and must never propagate a failure.
            await service.notify_all(title="t", body="b")

    asyncio.run(run())
    store.remove_subscription.assert_not_called()
