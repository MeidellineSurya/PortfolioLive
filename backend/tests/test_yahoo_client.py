import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from yahoo_client import YahooClient

RAW_ARTICLE = {
    "id": "9c3057f0-fbd5-3512-b118-6e66c0577d47",
    "content": {
        "title": "TLKM vs. Peers: Which Stock Is the Better Value Option?",
        "summary": "TLKM vs. Peers: Which Stock Is the Better Value Option?",
        "pubDate": "2026-02-19T16:40:03Z",
        "canonicalUrl": {"url": "https://finance.yahoo.com/news/tlkm-vs-peers"},
    },
}


async def noop_on_quote(ticker, price):
    pass


def test_to_article_maps_a_well_formed_item():
    article = YahooClient._to_article("TLKM.JK", RAW_ARTICLE)

    assert article is not None
    assert article.id == "9c3057f0-fbd5-3512-b118-6e66c0577d47"
    assert article.headline == "TLKM vs. Peers: Which Stock Is the Better Value Option?"
    assert article.url == "https://finance.yahoo.com/news/tlkm-vs-peers"
    assert article.published_at == "2026-02-19T16:40:03Z"
    # A Yahoo fetch is always scoped to one ticker, unlike Alpaca's
    # articles which can tag several — symbols is always a singleton.
    assert article.symbols == ["TLKM.JK"]


def test_to_article_falls_back_to_headline_when_summary_is_blank():
    item = {**RAW_ARTICLE, "content": {**RAW_ARTICLE["content"], "summary": ""}}
    article = YahooClient._to_article("TLKM.JK", item)
    assert article.summary == article.headline


def test_to_article_returns_none_for_a_malformed_item():
    # yfinance's news response is unofficial/undocumented; a missing key
    # must not raise and kill the rest of the batch.
    assert YahooClient._to_article("TLKM.JK", {"id": "abc"}) is None
    assert YahooClient._to_article("TLKM.JK", {}) is None


def test_fetch_news_skips_a_failing_ticker_without_dropping_others():
    def fake_ticker(symbol, session=None):
        mock = MagicMock()
        if symbol == "BROKEN.JK":
            mock.get_news.side_effect = RuntimeError("Yahoo is down")
        else:
            mock.get_news.return_value = [RAW_ARTICLE]
        return mock

    async def run():
        with patch("yahoo_client.yf.Ticker", side_effect=fake_ticker):
            client = YahooClient(noop_on_quote)
            return await client.fetch_news(["TLKM.JK", "BROKEN.JK", "BMRI.JK"], limit=3)

    articles = asyncio.run(run())

    assert [a.symbols for a in articles] == [["TLKM.JK"], ["BMRI.JK"]]


def test_fetch_news_passes_limit_as_count():
    mock_ticker = MagicMock()
    mock_ticker.get_news.return_value = [RAW_ARTICLE]

    async def run():
        with patch("yahoo_client.yf.Ticker", return_value=mock_ticker):
            client = YahooClient(noop_on_quote)
            await client.fetch_news(["TLKM.JK"], limit=7)

    asyncio.run(run())

    mock_ticker.get_news.assert_called_once_with(count=7)


def test_poll_once_skips_a_ticker_whose_price_is_unchanged():
    # Alpaca's push feed only fires on a genuine quote change; when the
    # market's closed it sends nothing. This poll loop runs on a fixed
    # timer regardless, so it must suppress re-emitting an unchanged
    # price itself, or a closed-market ticker would get a flood of
    # identical ticks (and a flat sparkline) instead of the "no live
    # data right now" state an Alpaca-backed ticker correctly shows.
    on_quote = AsyncMock()

    async def run():
        client = YahooClient(on_quote)
        await client.subscribe_quote("TLKM.JK")
        with patch.object(client, "_fetch_recent_closes", return_value={"TLKM.JK": [2600.0, 2600.0]}):
            await client._poll_once()
            await client._poll_once()

    asyncio.run(run())

    on_quote.assert_awaited_once_with("TLKM.JK", 2600.0)


def test_poll_once_still_emits_on_a_genuine_price_change():
    on_quote = AsyncMock()
    responses = iter([{"TLKM.JK": [2600.0, 2600.0]}, {"TLKM.JK": [2600.0, 2630.0]}])

    async def run():
        client = YahooClient(on_quote)
        await client.subscribe_quote("TLKM.JK")
        with patch.object(client, "_fetch_recent_closes", side_effect=lambda tickers: next(responses)):
            await client._poll_once()
            await client._poll_once()

    asyncio.run(run())

    assert on_quote.await_args_list[0].args == ("TLKM.JK", 2600.0)
    assert on_quote.await_args_list[1].args == ("TLKM.JK", 2630.0)
