"""News fetching + Groq summarisation.

Consumes the raw news batches ``AlpacaClient`` polls every 60s, groups them
per tracked ticker — portfolio holdings and watchlist entries alike
(latest 5 each), summarises each with Groq, and broadcasts the result to
connected frontend clients via ``WebSocketManager``.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime

import redis.asyncio as redis
from groq import AsyncGroq

import metrics
from alpaca_client import AlpacaClient, NewsArticle
from models import NewsItem
from portfolio_store import PortfolioStore
from watchlist_store import WatchlistStore
from websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

NEWS_ITEMS_PER_TICKER = 5
SUMMARY_CACHE_TTL_SECONDS = 300
GROQ_MODEL = "llama-3.3-70b-versatile"
# "Load more" fetches this many extra candidates beyond what the caller
# asked for, since Alpaca's `end` filter is inclusive (see get_more_news)
# and some of what comes back will already be in `_broadcast_ids`.
LOAD_MORE_FETCH_MULTIPLIER = 3

SYSTEM_PROMPT = (
    "You summarise financial news in exactly one sentence under 20 words. "
    "Focus on market impact. Never start with 'The'."
)


class NewsService:
    def __init__(
        self,
        alpaca_client: AlpacaClient,
        portfolio_store: PortfolioStore,
        watchlist_store: WatchlistStore,
        ws_manager: WebSocketManager,
        groq_api_key: str,
        redis_url: str,
    ):
        self._alpaca = alpaca_client
        self._store = portfolio_store
        self._watchlist = watchlist_store
        self._ws_manager = ws_manager
        self._groq = AsyncGroq(api_key=groq_api_key)
        # A dedicated connection, separate from PortfolioStore's — this
        # cache is about summarisation cost, not portfolio state, and
        # keeping the two independent means neither module needs to know
        # about the other's Redis usage.
        self._redis = redis.from_url(redis_url, decode_responses=True)
        # Tracks article ids already broadcast this process's lifetime.
        # Alpaca's news feed has no "since" cursor, so the same handful of
        # articles reappear in every 60s poll until they age out of the
        # "latest N" window; without this, already-seen headlines would be
        # re-sent to clients every cycle and flood the news feed. In-memory
        # (not Redis) and unbounded-for-process-lifetime is deliberate: it
        # resets on restart, which is fine because the whole portfolio is
        # already re-subscribed from scratch on restart (see websocket
        # manager, commit 3).
        self._broadcast_ids: set[int] = set()

    def start(self) -> None:
        self._alpaca.start_news_polling(get_tickers=self._get_tracked_tickers, on_batch=self._handle_batch)

    async def _get_tracked_tickers(self) -> list[str]:
        holdings = await self._store.get_all_holdings()
        watchlist = await self._watchlist.get_all_tickers()
        return list({h.ticker for h in holdings} | set(watchlist))

    async def _handle_batch(self, articles: list[NewsArticle]) -> None:
        tracked_tickers = set(await self._get_tracked_tickers())
        by_ticker: dict[str, list[NewsArticle]] = defaultdict(list)
        for article in articles:
            for symbol in article.symbols:
                if symbol in tracked_tickers:
                    by_ticker[symbol].append(article)

        for ticker, ticker_articles in by_ticker.items():
            for article in ticker_articles[:NEWS_ITEMS_PER_TICKER]:
                if article.id in self._broadcast_ids:
                    continue
                try:
                    await self._process_article(ticker, article)
                except Exception:
                    logger.exception("failed to process news article %s for %s", article.id, ticker)
                else:
                    self._broadcast_ids.add(article.id)

    async def _process_article(self, ticker: str, article: NewsArticle) -> None:
        item = await self._build_news_item(ticker, article)
        await self._ws_manager.broadcast(item.model_dump())

    async def _build_news_item(self, ticker: str, article: NewsArticle) -> NewsItem:
        ai_summary = await self._summarise_cached(article)
        metrics.news_summaries_generated_total.inc()
        return NewsItem(
            ticker=ticker,
            headline=article.headline,
            ai_summary=ai_summary,
            url=article.url,
            published_at=article.published_at,
        )

    async def get_more_news(self, ticker: str, before: datetime | None, limit: int) -> list[NewsItem]:
        """On-demand "load more" for a single ticker, past whatever the 60s
        poll cycle has already broadcast for it.

        Alpaca's ``end`` filter is inclusive — passing the oldest
        currently-displayed article's timestamp back as ``end`` would
        return that same article again as the first result. Rather than
        subtracting an epsilon from the timestamp (fragile: depends on
        Alpaca's actual timestamp precision, which isn't documented),
        this over-fetches and filters out anything already in
        `_broadcast_ids` — the same set that already prevents the poll
        cycle from re-broadcasting an article, reused here for exactly the
        same purpose.
        """
        candidates = await self._alpaca.fetch_news(
            [ticker], limit=limit * LOAD_MORE_FETCH_MULTIPLIER, end=before
        )
        fresh = [article for article in candidates if article.id not in self._broadcast_ids][:limit]

        items: list[NewsItem] = []
        for article in fresh:
            item = await self._build_news_item(ticker, article)
            items.append(item)
            # Marked here, not just left to the next poll cycle: without
            # this, the very next 60s poll could re-broadcast an article
            # the user just explicitly loaded, appearing as an unexpected
            # duplicate at the top of the live feed.
            self._broadcast_ids.add(article.id)
        return items

    async def _summarise_cached(self, article: NewsArticle) -> str:
        cache_key = f"news_summary:{article.id}"
        cached = await self._redis.get(cache_key)
        if cached:
            metrics.news_cache_hits_total.inc()
            return cached

        metrics.news_cache_misses_total.inc()
        summary = await self._summarise(article)
        await self._redis.set(cache_key, summary, ex=SUMMARY_CACHE_TTL_SECONDS)
        return summary

    async def _summarise(self, article: NewsArticle) -> str:
        response = await self._groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"{article.headline}. {article.summary}"},
            ],
            temperature=0.3,
            max_completion_tokens=60,
        )
        metrics.groq_api_calls_total.inc()
        return response.choices[0].message.content.strip()
