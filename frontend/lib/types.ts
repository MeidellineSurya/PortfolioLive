// Field names intentionally match the backend's wire format exactly
// (snake_case) rather than being remapped to camelCase. The backend
// (backend/models.py) sends Pydantic `model_dump()` JSON as-is with no
// alias config, so keeping these types snake_case avoids a translation
// layer for every message that crosses the WebSocket.

export type Holding = {
  ticker: string;
  quantity: number;
  avg_cost: number;
};

export type PriceUpdate = {
  type: "price_update";
  ticker: string;
  price: number;
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

export type WSMessage = PriceUpdate | NewsItem;

// A holding merged with whatever live price data has arrived for it so
// far. The price fields are optional because a holding exists in the
// table (from GET /portfolio) before its first `price_update` tick
// arrives — the row renders with placeholders until then.
export type PortfolioRow = Holding &
  Partial<Omit<PriceUpdate, "type" | "ticker">>;

