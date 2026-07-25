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

from alpaca_client import OnQuote

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 20


class YahooClient:
    def __init__(self, on_quote: OnQuote):
        self._on_quote = on_quote
        self._subscribed: set[str] = set()
        self._poll_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

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
            tickers = list(self._subscribed)
            if tickers:
                try:
                    closes = await asyncio.to_thread(self._fetch_recent_closes, tickers)
                    for ticker, prices in closes.items():
                        if prices:
                            await self._on_quote(ticker, prices[-1])
                except Exception:
                    logger.exception("Yahoo quote poll failed")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=POLL_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass

    @staticmethod
    def _fetch_recent_closes(tickers: list[str]) -> dict[str, list[float]]:
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
