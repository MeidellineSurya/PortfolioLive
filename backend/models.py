"""Pydantic models shared across the backend."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

TICKER_RE = re.compile(r"^[A-Z]{1,5}$")


class Holding(BaseModel):
    ticker: str
    quantity: float = Field(gt=0)
    avg_cost: float = Field(gt=0)

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        v = v.strip().upper()
        if not TICKER_RE.match(v):
            raise ValueError("ticker must be 1-5 uppercase letters (A-Z)")
        return v


class HoldingWithPrice(Holding):
    """GET /portfolio's response shape — a Holding plus whatever last-known
    price data WebSocketManager has for it (commit 17). Kept separate from
    Holding rather than adding optional fields directly to it: Holding is
    also the POST /portfolio/add request body, and conflating "what you
    send to create a holding" with "what you get back" would make the
    request schema misleadingly show price fields that only ever apply to
    responses.
    """

    price: float | None = None
    position_value: float | None = None
    position_pnl: float | None = None
    position_pnl_pct: float | None = None


class PriceUpdate(BaseModel):
    type: Literal["price_update"] = "price_update"
    ticker: str
    price: float
    change: float
    change_pct: float
    position_value: float
    position_pnl: float
    position_pnl_pct: float


class NewsItem(BaseModel):
    type: Literal["news_update"] = "news_update"
    ticker: str
    headline: str
    ai_summary: str
    url: str
    published_at: str


class PriceAlertCreate(BaseModel):
    ticker: str
    target_price: float = Field(gt=0)

    # Duplicated from Holding rather than shared via a mixin — two fields
    # isn't enough repetition to justify the indirection of pulling this
    # out, and the two models validate the same field for unrelated
    # reasons (a holding you own vs. a price you're watching for).
    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        v = v.strip().upper()
        if not TICKER_RE.match(v):
            raise ValueError("ticker must be 1-5 uppercase letters (A-Z)")
        return v


class PriceAlert(BaseModel):
    id: str
    ticker: str
    target_price: float
    triggered: bool = False


class PriceAlertTriggered(BaseModel):
    type: Literal["price_alert"] = "price_alert"
    id: str
    ticker: str
    target_price: float
    price: float
    direction: Literal["above", "below"]


class HoldingSnapshot(BaseModel):
    price: float
    value: float
    pnl_pct: float


class PortfolioSnapshot(BaseModel):
    timestamp: str
    total_value: float
    total_pnl: float
    total_pnl_pct: float
    holdings: dict[str, HoldingSnapshot]


class PerformanceEntry(BaseModel):
    ticker: str
    change_pct: float


class AnalyticsResponse(BaseModel):
    total_pnl: float
    total_pnl_pct: float
    history: list[PortfolioSnapshot]
    best_performer_7d: PerformanceEntry | None
    worst_performer_7d: PerformanceEntry | None
