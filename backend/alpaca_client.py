"""Alpaca price streaming (WebSocket) and news polling (REST).

Threading model
----------------
alpaca-py's ``StockDataStream`` is built around ``asyncio.run(...)`` owning
its own event loop (see ``DataStream.run`` in the SDK). Live subscription
changes made *after* the stream is connected go through
``asyncio.run_coroutine_threadsafe(coro, self._loop).result()`` — a
cross-thread handoff that blocks the calling thread until the stream's loop
executes the coroutine.

If we drove the stream from inside FastAPI's own event loop (e.g. via
``asyncio.create_task(stream._run_forever())``), then a *later* call to
``subscribe_quotes``/``unsubscribe_quotes`` from a route handler would try to
schedule work on that same loop and then synchronously block on
``.result()`` from within that same loop's thread — a guaranteed deadlock,
since the loop can't service the callback while it's blocked waiting for it.

So the stream is run on a dedicated background thread via the SDK's public,
blocking ``stream.run()`` entry point. Subscribe/unsubscribe calls from the
FastAPI (main) thread are then genuinely cross-thread and safe. Quote
callbacks fire on the stream thread's loop, so they hand back to the main
loop via ``run_coroutine_threadsafe`` (fire-and-forget) rather than doing
async work directly.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from alpaca.data.enums import DataFeed
from alpaca.data.historical.news import NewsClient
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.live.stock import StockDataStream
from alpaca.data.models.news import News
from alpaca.data.models.quotes import Quote
from alpaca.data.requests import NewsRequest, StockSnapshotRequest

logger = logging.getLogger(__name__)

NEWS_POLL_INTERVAL_SECONDS = 60
NEWS_FETCH_LIMIT = 50
RECONNECT_BASE_DELAY_SECONDS = 1
RECONNECT_MAX_DELAY_SECONDS = 30

OnQuote = Callable[[str, float], Awaitable[None]]
OnNewsBatch = Callable[["list[NewsArticle]"], Awaitable[None]]
GetTickers = Callable[[], Awaitable["list[str]"]]


@dataclass(frozen=True)
class NewsArticle:
    id: int
    headline: str
    summary: str
    url: str
    published_at: str
    symbols: list[str]


class AlpacaClient:
    def __init__(self, api_key: str, secret_key: str, on_quote: OnQuote):
        self._api_key = api_key
        self._secret_key = secret_key
        self._on_quote = on_quote
        self._news_client = NewsClient(api_key, secret_key)
        self._history_client = StockHistoricalDataClient(api_key, secret_key)

        # Captured here (constructed during FastAPI startup, on the app's
        # loop) so quote callbacks running on the stream thread can hand
        # work back to the main loop.
        self._main_loop = asyncio.get_running_loop()

        self._stream: StockDataStream | None = None
        self._stream_lock = threading.Lock()
        self._subscribed: set[str] = set()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

        self._news_task: asyncio.Task | None = None

    # ---- lifecycle ---------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_stream_with_backoff, name="alpaca-stream", daemon=True
        )
        self._thread.start()

    async def stop(self) -> None:
        self._stop_event.set()
        with self._stream_lock:
            stream = self._stream
        if stream is not None:
            await asyncio.to_thread(stream.stop)
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, 5)
        if self._news_task is not None:
            self._news_task.cancel()

    # ---- price streaming ----------------------------------------------

    async def subscribe_quote(self, ticker: str) -> None:
        if ticker in self._subscribed:
            return
        self._subscribed.add(ticker)
        with self._stream_lock:
            stream = self._stream
        if stream is not None:
            # Blocks briefly on a cross-thread round trip to the stream
            # thread; run off the event loop so we don't stall other
            # requests while it does.
            await asyncio.to_thread(stream.subscribe_quotes, self._handle_quote, ticker)

    async def unsubscribe_quote(self, ticker: str) -> None:
        if ticker not in self._subscribed:
            return
        self._subscribed.discard(ticker)
        with self._stream_lock:
            stream = self._stream
        if stream is not None:
            await asyncio.to_thread(stream.unsubscribe_quotes, ticker)

    async def _handle_quote(self, quote: Quote) -> None:
        # The midpoint of bid/ask, not "ask, falling back to bid" — the
        # previous version picked whichever side happened to be non-zero
        # on a given tick, with no consistent rule. Two consecutive ticks
        # could land on opposite sides of the spread (e.g. IEX quoting
        # AAPL at bid $324.10 / ask $324.14 — a real, verified spread, not
        # a hypothetical one) with no real price movement between them,
        # which reads as the price sporadically jumping every tick. The
        # midpoint is deterministic per tick and doesn't have that
        # flip-flop artifact. Only fall back to a single side when the
        # other is genuinely absent (a one-sided/thin quote) — dropping
        # the tick entirely in that case would discard real, if partial,
        # information.
        ask, bid = quote.ask_price, quote.bid_price
        price = (ask + bid) / 2 if (ask and bid) else (ask or bid)
        if not price:
            return
        # Runs on the stream thread's loop; hand off to the main loop
        # without blocking this thread on the result.
        future = asyncio.run_coroutine_threadsafe(
            self._on_quote(quote.symbol, float(price)), self._main_loop
        )
        future.add_done_callback(self._log_if_failed)

    @staticmethod
    def _log_if_failed(future: "asyncio.Future") -> None:
        exc = future.exception()
        if exc is not None:
            logger.exception("on_quote callback failed", exc_info=exc)

    def _run_stream_with_backoff(self) -> None:
        """Runs on the background thread. Restarts the stream (with a fresh
        ``StockDataStream`` instance, since a used one's internal loop is
        spent) if it ever exits unexpectedly, backing off exponentially so a
        persistent failure (e.g. bad credentials) doesn't hot-loop against
        Alpaca's API.
        """
        delay = RECONNECT_BASE_DELAY_SECONDS
        while not self._stop_event.is_set():
            stream = StockDataStream(self._api_key, self._secret_key, feed=DataFeed.IEX)
            for ticker in list(self._subscribed):
                stream.subscribe_quotes(self._handle_quote, ticker)
            with self._stream_lock:
                self._stream = stream

            logger.info("starting Alpaca price stream")
            try:
                stream.run()  # blocks until stream.stop() or a fatal error
                delay = RECONNECT_BASE_DELAY_SECONDS
            except Exception:
                logger.exception("Alpaca price stream crashed")

            with self._stream_lock:
                self._stream = None

            if self._stop_event.is_set():
                break
            logger.warning("Alpaca price stream ended, reconnecting in %ss", delay)
            self._stop_event.wait(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY_SECONDS)

    # ---- reference data ---------------------------------------------------

    async def get_previous_close(self, ticker: str) -> float | None:
        """Previous trading day's close, used as the baseline for the
        ``change``/``change_pct`` fields on price updates. Cheap, one-shot
        REST call — fetched once when a ticker starts being tracked, not on
        every tick.
        """
        request = StockSnapshotRequest(symbol_or_symbols=ticker, feed=DataFeed.IEX)
        snapshots = await asyncio.to_thread(self._history_client.get_stock_snapshot, request)
        snapshot = snapshots.get(ticker)
        if snapshot is None or snapshot.previous_daily_bar is None:
            return None
        return float(snapshot.previous_daily_bar.close)

    # ---- news polling ---------------------------------------------------

    def start_news_polling(self, get_tickers: GetTickers, on_batch: OnNewsBatch) -> None:
        if self._news_task is not None:
            return
        self._news_task = asyncio.create_task(self._poll_news_forever(get_tickers, on_batch))

    async def _poll_news_forever(self, get_tickers: GetTickers, on_batch: OnNewsBatch) -> None:
        while True:
            try:
                tickers = await get_tickers()
                logger.info("news poll cycle: %d ticker(s)", len(tickers))
                if tickers:
                    articles = await self.fetch_news(tickers)
                    logger.info("news poll cycle: fetched %d article(s)", len(articles))
                    if articles:
                        await on_batch(articles)
            except Exception:
                # Must not escape this loop: an asyncio.Task's exception is
                # only surfaced when something awaits/retrieves it or the
                # Task is garbage collected. self._news_task holds a
                # permanent reference, so an uncaught exception here would
                # kill polling forever with no visible error at all — not
                # even a log line — rather than a loud crash.
                logger.exception("news polling cycle failed")
            await asyncio.sleep(NEWS_POLL_INTERVAL_SECONDS)

    async def fetch_news(
        self, tickers: "list[str]", limit: int = NEWS_FETCH_LIMIT, end: datetime | None = None
    ) -> "list[NewsArticle]":
        """One-shot REST fetch of the latest news across ``tickers``.

        ``end``, when given, fetches articles published at or before that
        timestamp (Alpaca's own semantics — verified live: it's inclusive,
        not exclusive) rather than the current latest. Used for "load
        more" pagination (news_service.py); the regular 60s poll never
        passes it.

        ``NewsClient.get_news`` is a blocking `requests` call, so it's
        pushed to a worker thread to avoid stalling the event loop.
        """
        request = NewsRequest(symbols=",".join(tickers), limit=limit, exclude_contentless=True, end=end)
        news_set = await asyncio.to_thread(self._news_client.get_news, request)
        return [self._to_article(item) for item in news_set.data["news"]]

    @staticmethod
    def _to_article(item: News) -> NewsArticle:
        return NewsArticle(
            id=item.id,
            headline=item.headline,
            summary=item.summary or item.headline,
            url=item.url,
            published_at=item.created_at.isoformat(),
            symbols=list(item.symbols or []),
        )
