"""News fetching + Groq summarisation.

Consumes the raw news batches ``AlpacaClient`` polls every 60s, groups them
per portfolio ticker (latest 5), summarises each with Groq, and broadcasts
the result to connected frontend clients via ``WebSocketManager``.
"""
from __future__ import annotations

import logging
from collections import defaultdict

import redis.asyncio as redis
from groq import AsyncGroq

from alpaca_client import AlpacaClient, NewsArticle
from models import NewsItem
from portfolio_store import PortfolioStore
from websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

NEWS_ITEMS_PER_TICKER = 5
SUMMARY_CACHE_TTL_SECONDS = 300
GROQ_MODEL = "llama-3.3-70b-versatile"

SYSTEM_PROMPT = (
    "You summarise financial news in exactly one sentence under 20 words. "
    "Focus on market impact. Never start with 'The'."
)


class NewsService:
    def __init__(
        self,
        alpaca_client: AlpacaClient,
        portfolio_store: PortfolioStore,
        ws_manager: WebSocketManager,
        groq_api_key: str,
        redis_url: str,
    ):
        self._alpaca = alpaca_client
        self._store = portfolio_store
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
        self._alpaca.start_news_polling(get_tickers=self._get_portfolio_tickers, on_batch=self._handle_batch)

    async def _get_portfolio_tickers(self) -> list[str]:
        holdings = await self._store.get_all_holdings()
        return [h.ticker for h in holdings]

    async def _handle_batch(self, articles: list[NewsArticle]) -> None:
        portfolio_tickers = set(await self._get_portfolio_tickers())
        by_ticker: dict[str, list[NewsArticle]] = defaultdict(list)
        for article in articles:
            for symbol in article.symbols:
                if symbol in portfolio_tickers:
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
        ai_summary = await self._summarise_cached(article)
        item = NewsItem(
            ticker=ticker,
            headline=article.headline,
            ai_summary=ai_summary,
            url=article.url,
            published_at=article.published_at,
        )
        await self._ws_manager.broadcast(item.model_dump())

    async def _summarise_cached(self, article: NewsArticle) -> str:
        cache_key = f"news_summary:{article.id}"
        cached = await self._redis.get(cache_key)
        if cached:
            return cached

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
        return response.choices[0].message.content.strip()
