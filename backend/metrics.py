"""Prometheus metrics — one central module so every file that needs to
record something imports from here, rather than each module declaring its
own `Counter`/`Gauge`. Metric objects are tied to prometheus_client's
default global registry at creation time; declaring the same metric name
twice (e.g. if two modules each did `Counter("news_cache_hits_total", ...)`
independently) raises at import time — a single source of truth avoids
that entirely, not just tidies it up.

Cache hit rate is deliberately exposed as two raw counters (hits, misses),
not a precomputed ratio gauge — that's the idiomatic Prometheus pattern:
a ratio computed server-side can only ever reflect "since process start,"
while `rate(hits[5m]) / (rate(hits[5m]) + rate(misses[5m]))` in PromQL
gives a windowed rate over whatever period you actually care about.
"""
from prometheus_client import Counter, Gauge

active_websocket_connections = Gauge(
    "portfoliolive_active_websocket_connections",
    "Number of frontend WebSocket clients currently connected",
)

groq_api_calls_total = Counter(
    "portfoliolive_groq_api_calls_total",
    "Total chat completion calls made to the Groq API",
)

news_summaries_generated_total = Counter(
    "portfoliolive_news_summaries_generated_total",
    "Total news items summarised and delivered (broadcast or via load-more), cached or not",
)

news_cache_hits_total = Counter(
    "portfoliolive_news_cache_hits_total",
    "News summary requests served from the Redis cache",
)

news_cache_misses_total = Counter(
    "portfoliolive_news_cache_misses_total",
    "News summary requests that required a fresh Groq call",
)
