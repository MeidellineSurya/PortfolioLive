"""Yahoo Finance quote polling for Indonesia Stock Exchange (IDX) tickers.

Alpaca has no Indonesia coverage, so `.JK`-suffixed tickers (e.g.
BBCA.JK) are routed here instead (see models.py's currency_for_ticker).
Yahoo's public data has no push/streaming feed on the free, unofficial
route this app uses — quotes are polled on an interval and delivered
through the same on_quote(ticker, price) callback shape AlpacaClient
uses (alpaca_client.py's OnQuote), so WebSocketManager doesn't need to
know or care which source a given tick came from.

Threading model
----------------
Unlike AlpacaClient, this needs no dedicated thread. yfinance's calls
are blocking REST requests, not a persistent stream connection, so
there's none of Alpaca's cross-thread subscribe/deadlock risk (see
alpaca_client.py's module docstring) — an asyncio.create_task poll loop
pushing each blocking call through asyncio.to_thread is sufficient.
"""
from __future__ import annotations

import asyncio
import logging

import yfinance as yf
from yfinance._http import new_session

from alpaca_client import NewsArticle, OnQuote

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 20
NEWS_FETCH_LIMIT = 5


class YahooClient:
    def __init__(self, on_quote: OnQuote):
        self._on_quote = on_quote
        self._subscribed: set[str] = set()
        self._poll_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        # yfinance creates a brand-new HTTP session internally whenever no
        # `session=` is passed to `yf.download`/`yf.Ticker` — meaning every
        # 20-second poll cycle, and every ticker in every news fetch, opened
        # a fresh session (and its underlying socket) that only got closed
        # whenever the garbage collector got around to it. Confirmed live as
        # the cause of a real outage: this process ran for ~27 hours before
        # exhausting its file descriptor limit ("Too many open files"),
        # taking down the whole backend even though nothing had crashed.
        # One shared, reused session for the process's lifetime fixes the
        # leak at the source, same as AlpacaClient reusing a single
        # NewsClient/StockHistoricalDataClient instead of one per call.
        self._session = new_session()
        # Alpaca's push feed only ever fires on a genuine quote change —
        # when the market's closed, it sends nothing at all. This poll
        # loop runs on a fixed timer regardless of market state, so
        # without tracking what was last emitted it would re-broadcast
        # the same unchanged closing price every cycle while IDX is
        # closed (most of the day) — flooding priceHistory with
        # identical points and rendering as a flat horizontal sparkline
        # instead of the "no live data" state Alpaca-backed tickers
        # correctly show in the same situation.
        self._last_emitted: dict[str, float] = {}

    # ---- lifecycle ---------------------------------------------------

    def start(self) -> None:
        if self._poll_task is not None:
            return
        self._poll_task = asyncio.create_task(self._poll_forever())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._poll_task is not None:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

    # ---- price polling -------------------------------------------------

    async def subscribe_quote(self, ticker: str) -> None:
        self._subscribed.add(ticker)

    async def unsubscribe_quote(self, ticker: str) -> None:
        self._subscribed.discard(ticker)

    async def get_previous_close(self, ticker: str) -> float | None:
        """Mirrors AlpacaClient.get_previous_close's contract (last
        *completed* trading day's close), used identically by
        WebSocketManager to seed the change/change_pct baseline when a
        ticker starts being tracked.
        """
        closes = await asyncio.to_thread(self._fetch_recent_closes, [ticker])
        prices = closes.get(ticker, [])
        if len(prices) < 2:
            return None
        return prices[-2]

    async def _poll_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._poll_once()
            except Exception:
                logger.exception("Yahoo quote poll failed")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=POLL_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def _poll_once(self) -> None:
        tickers = list(self._subscribed)
        if not tickers:
            return
        closes = await asyncio.to_thread(self._fetch_recent_closes, tickers)
        for ticker, prices in closes.items():
            if not prices:
                continue
            price = prices[-1]
            if self._last_emitted.get(ticker) == price:
                continue
            self._last_emitted[ticker] = price
            await self._on_quote(ticker, price)

    # ---- news -----------------------------------------------------------

    async def fetch_news(self, tickers: list[str], limit: int = NEWS_FETCH_LIMIT) -> list[NewsArticle]:
        """Mirrors AlpacaClient.fetch_news's contract as closely as
        yfinance allows. Unlike price data, yfinance has no batched
        multi-ticker news call (verified live: Ticker.get_news is
        per-symbol) — this loops per ticker, each blocking call pushed to
        a worker thread. Wrapped per-ticker, not just once around the
        whole loop: yfinance's news endpoint can raise on a single bad
        response (YFDataException/JSONDecodeError, seen in its source),
        and one ticker failing shouldn't drop every other ticker's news
        for that poll cycle.
        """
        articles: list[NewsArticle] = []
        for ticker in tickers:
            try:
                raw_items = await asyncio.to_thread(
                    yf.Ticker(ticker, session=self._session).get_news, count=limit
                )
            except Exception:
                logger.exception("Yahoo news fetch failed for %s", ticker)
                continue
            for item in raw_items:
                article = self._to_article(ticker, item)
                if article is not None:
                    articles.append(article)
        return articles

    @staticmethod
    def _to_article(ticker: str, item: dict) -> NewsArticle | None:
        # A Yahoo fetch is already scoped to one ticker (unlike Alpaca's
        # articles, which can tag several) — symbols is a singleton list
        # so NewsService's existing per-symbol bucketing logic (built for
        # Alpaca's multi-symbol case) works unchanged for either source.
        try:
            content = item["content"]
            return NewsArticle(
                id=str(item["id"]),
                headline=content["title"],
                summary=content.get("summary") or content["title"],
                url=content["canonicalUrl"]["url"],
                published_at=content["pubDate"],
                symbols=[ticker],
            )
        except (KeyError, TypeError):
            # yfinance's news response is unofficial/undocumented and has
            # been observed to include sparse or malformed entries — skip
            # rather than let one bad article drop the rest of the batch.
            logger.warning("skipping malformed Yahoo news article for %s", ticker)
            return None

    def _fetch_recent_closes(self, tickers: list[str]) -> dict[str, list[float]]:
        """One batched HTTP round trip covering every tracked ticker, not
        one call each — polite to an unofficial, rate-limit-sensitive API
        regardless of how many IDX tickers are tracked (verified live:
        yfinance groups by ticker in the response even for a single
        symbol, so this shape is uniform for both the poll loop and
        get_previous_close's single-ticker call). Returns up to the last
        5 daily closes per ticker, oldest first, so callers can take the
        latest (`[-1]`) or previous-completed-day (`[-2]`) close; a
        ticker with no data (e.g. invalid or newly listed) is simply
        absent from the result rather than raising.
        """
        data = yf.download(
            tickers=" ".join(tickers),
            period="5d",
            interval="1d",
            group_by="ticker",
            progress=False,
            threads=True,
            session=self._session,
        )
        result: dict[str, list[float]] = {}
        for ticker in tickers:
            try:
                closes = data[ticker]["Close"].dropna()
            except KeyError:
                continue
            if len(closes):
                result[ticker] = [float(v) for v in closes.tolist()]
        return result
