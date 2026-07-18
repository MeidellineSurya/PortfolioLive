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
