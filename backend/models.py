"""Pydantic models shared across the backend."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# A bare `[A-Z]{1,5}` ticker is US (Alpaca); a `.JK`-suffixed one is an
# Indonesia Stock Exchange ticker (e.g. BBCA.JK), routed to Yahoo Finance
# instead — see yahoo_client.py and currency_for_ticker below. The suffix
# is the single signal both for "which data source" and "which currency
# this is priced in"; no separate exchange/currency field is stored
# anywhere, it's always derived from the ticker string itself.
TICKER_RE = re.compile(r"^[A-Z]{1,5}(\.JK)?$")


def _validate_ticker(v: str) -> str:
    v = v.strip().upper()
    if not TICKER_RE.match(v):
        raise ValueError("ticker must be 1-5 uppercase letters (A-Z), optionally suffixed with .JK")
    return v


def currency_for_ticker(ticker: str) -> Literal["USD", "IDR"]:
    return "IDR" if ticker.endswith(".JK") else "USD"


class Holding(BaseModel):
    ticker: str
    quantity: float = Field(gt=0)
    avg_cost: float = Field(gt=0)

    # A shared function, not a shared mixin class: three models now need
    # this exact check (Holding, PriceAlertCreate, WatchlistAdd), which is
    # enough duplication to dedupe the *logic* — but they validate the
    # same field for unrelated reasons (a holding you own, a price you're
    # watching for, a ticker you're tracking without owning), so forcing
    # them into a common base class would couple three otherwise-unrelated
    # models just to save four lines each.
    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        return _validate_ticker(v)


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
    # Unlike price (unknown until the first tick arrives), currency is a
    # property of the ticker itself and is always known immediately.
    currency: Literal["USD", "IDR"]
    position_value: float | None = None
    position_pnl: float | None = None
    position_pnl_pct: float | None = None


class PriceUpdate(BaseModel):
    type: Literal["price_update"] = "price_update"
    ticker: str
    price: float
    currency: Literal["USD", "IDR"]
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

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        return _validate_ticker(v)


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


class CurrencyTotals(BaseModel):
    total_value: float
    total_pnl: float
    total_pnl_pct: float


class PortfolioSnapshot(BaseModel):
    """Totals are segregated by currency, not summed into one number —
    a $ amount and an Rp amount can't be added together without an FX
    conversion this app deliberately doesn't do (see DECISION_LOG). Keyed
    by currency code ("USD"/"IDR") and only populated for currencies that
    actually have holdings at snapshot time, rather than fixed fields for
    every currency this app happens to support today.
    """

    timestamp: str
    totals: dict[str, CurrencyTotals]
    holdings: dict[str, HoldingSnapshot]


class PerformanceEntry(BaseModel):
    ticker: str
    change_pct: float


class AnalyticsResponse(BaseModel):
    totals: dict[str, CurrencyTotals]
    history: list[PortfolioSnapshot]
    best_performer_7d: PerformanceEntry | None
    worst_performer_7d: PerformanceEntry | None


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class WatchlistAdd(BaseModel):
    ticker: str

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        return _validate_ticker(v)


class WatchlistItem(BaseModel):
    ticker: str


class WatchlistItemWithPrice(WatchlistItem):
    """GET /watchlist's response shape — mirrors HoldingWithPrice, but with
    no P&L fields at all (not even as optionals): a watchlist ticker has
    no quantity/avg_cost, so "profit or loss" isn't a question that has an
    answer for it. Price + day change is the ceiling of what's meaningful
    to show.
    """

    price: float | None = None
    currency: Literal["USD", "IDR"]
    change: float | None = None
    change_pct: float | None = None


class WatchlistPriceUpdate(BaseModel):
    """A separate WS message type from PriceUpdate, not PriceUpdate with
    optional position_* fields. Every existing consumer of `price_update`
    (frontend reducer, PortfolioTable) already assumes a portfolio
    position exists behind it — overloading one message type to sometimes
    carry P&L and sometimes not would push a "wait, which kind is this"
    check onto every consumer. A distinct `type` does that check once, at
    the point the message is dispatched.
    """

    type: Literal["watchlist_price_update"] = "watchlist_price_update"
    ticker: str
    price: float
    currency: Literal["USD", "IDR"]
    change: float
    change_pct: float


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscriptionCreate(BaseModel):
    """The shape a browser's PushSubscription.toJSON() produces (minus
    expirationTime, which pywebpush never needs) — the request body for
    POST /push/subscribe.
    """

    endpoint: str
    keys: PushSubscriptionKeys
