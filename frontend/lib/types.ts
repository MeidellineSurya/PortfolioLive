// Field names intentionally match the backend's wire format exactly
// (snake_case) rather than being remapped to camelCase. The backend
// (backend/models.py) sends Pydantic `model_dump()` JSON as-is with no
// alias config, so keeping these types snake_case avoids a translation
// layer for every message that crosses the WebSocket.

// A ticker's currency is always derived from its symbol (a bare US
// ticker vs. a .JK-suffixed Indonesia one — backend/models.py's
// currency_for_ticker), never chosen or stored separately, and the
// backend always includes it explicitly on every price-bearing payload
// rather than the frontend re-deriving it from the ticker string itself
// — one source of truth for something that affects money formatting.
export type Currency = "USD" | "IDR";

// The one deliberate exception to "always take currency from the
// backend": an optimistic local placeholder (page.tsx's ADD_TICKER)
// exists for a moment before any server response arrives at all, so
// there's nothing from the backend to take currency from yet. Mirrors
// backend/models.py's currency_for_ticker, the same way
// AddTickerForm.tsx already mirrors TICKER_RE for the same optimistic-UI
// reason — not a second source of truth for data that actually came
// from the wire.
export function currencyForTicker(ticker: string): Currency {
  return ticker.endsWith(".JK") ? "IDR" : "USD";
}

export type Holding = {
  ticker: string;
  quantity: number;
  avg_cost: number;
};

// GET /portfolio's response shape (backend/models.py's HoldingWithPrice):
// a Holding plus whatever last-known price data the backend has for it
// (commit 17) — absent entirely, not null, when unknown, since the
// backend serializes with exclude_none. This is what lets the table show
// real numbers on first load instead of always starting blank until the
// next live tick. `currency` is the one field always present regardless
// of whether a price has arrived yet.
export type HoldingWithPrice = Holding & {
  price?: number;
  currency: Currency;
  position_value?: number;
  position_pnl?: number;
  position_pnl_pct?: number;
};

export type PriceUpdate = {
  type: "price_update";
  ticker: string;
  price: number;
  currency: Currency;
  change: number;
  change_pct: number;
  position_value: number;
  position_pnl: number;
  position_pnl_pct: number;
};

export type NewsItem = {
  type: "news_update";
  ticker: string;
  headline: string;
  ai_summary: string;
  url: string;
  published_at: string;
};

export type PriceAlertTriggered = {
  type: "price_alert";
  id: string;
  ticker: string;
  target_price: number;
  price: number;
  direction: "above" | "below";
};

// A ticker tracked for price/news but not owned — no P&L fields exist at
// all here (not even optionally), unlike PriceUpdate: a watchlist ticker
// has no quantity/avg_cost, so "profit or loss" isn't a question with an
// answer for it. Kept as its own WS message type rather than PriceUpdate
// with optional position_* fields, so every existing `price_update`
// consumer (the portfolio reducer, PortfolioTable) can keep assuming a
// real position backs every message it receives.
export type WatchlistPriceUpdate = {
  type: "watchlist_price_update";
  ticker: string;
  price: number;
  currency: Currency;
  change: number;
  change_pct: number;
};

export type WSMessage = PriceUpdate | NewsItem | PriceAlertTriggered | WatchlistPriceUpdate;

// GET /watchlist's response shape (backend/models.py's WatchlistItemWithPrice).
export type WatchlistItem = {
  ticker: string;
  price?: number;
  currency: Currency;
  change?: number;
  change_pct?: number;
};

// A watchlist item merged with live price data, same "optional until the
// first tick" reasoning as PortfolioRow below — plus client-only
// `priceHistory` for its sparkline.
export type WatchlistRow = WatchlistItem & {
  priceHistory?: number[];
};

export type PriceAlert = {
  id: string;
  ticker: string;
  target_price: number;
  triggered: boolean;
};

export type HoldingSnapshot = {
  price: number;
  value: number;
  pnl_pct: number;
};

export type CurrencyTotals = {
  total_value: number;
  total_pnl: number;
  total_pnl_pct: number;
};

// Totals are keyed by currency, not a single pair of numbers — a $ total
// and an Rp total can't be summed together without an FX conversion this
// app deliberately doesn't do (see DECISION_LOG). Only currencies with
// at least one holding at snapshot time have an entry.
export type PortfolioSnapshot = {
  timestamp: string;
  totals: Record<string, CurrencyTotals>;
  holdings: Record<string, HoldingSnapshot>;
};

export type PerformanceEntry = {
  ticker: string;
  change_pct: number;
};

export type AnalyticsResponse = {
  totals: Record<string, CurrencyTotals>;
  history: PortfolioSnapshot[];
  best_performer_7d: PerformanceEntry | null;
  worst_performer_7d: PerformanceEntry | null;
};

// A holding merged with whatever live price data has arrived for it so
// far. The price fields are optional because a holding exists in the
// table (from GET /portfolio) before its first `price_update` tick
// arrives — the row renders with placeholders until then. `priceHistory`
// is client-only state (not part of the backend's PriceUpdate shape) —
// the last N prices seen, oldest first, for the row's sparkline.
export type PortfolioRow = Holding &
  Partial<Omit<PriceUpdate, "type" | "ticker">> & {
    priceHistory?: number[];
  };

