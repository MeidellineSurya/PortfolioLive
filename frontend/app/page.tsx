"use client";

import Link from "next/link";
import { useEffect, useReducer, useState } from "react";

import AddTickerForm from "./components/AddTickerForm";
import NewsFeed from "./components/NewsFeed";
import PortfolioTable from "./components/PortfolioTable";
import ToastStack, { type ToastMessage } from "./components/Toast";
import WatchlistSection from "./components/Watchlist";
import { authFetch, clearToken, getToken, useRequireAuth } from "@/lib/auth";
import { useWebSocket } from "@/lib/websocket";
import type {
  Holding,
  HoldingWithPrice,
  NewsItem,
  PortfolioRow,
  PriceAlert,
  PriceUpdate,
  WatchlistItem,
  WatchlistRow,
  WatchlistPriceUpdate,
} from "@/lib/types";
import { formatCurrency, formatPercent, formatSignedCurrency } from "@/lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";
const MAX_NEWS_ITEMS = 20;
const MAX_PRICE_HISTORY = 20;

type PortfolioState = Record<string, PortfolioRow>;

type PortfolioAction =
  | { type: "SET_HOLDINGS"; holdings: HoldingWithPrice[] }
  | { type: "ADD_HOLDING"; holding: Holding }
  | { type: "REMOVE_HOLDING"; ticker: string }
  | { type: "PRICE_UPDATE"; update: PriceUpdate };

function portfolioReducer(state: PortfolioState, action: PortfolioAction): PortfolioState {
  switch (action.type) {
    case "SET_HOLDINGS": {
      // Merge rather than replace wholesale: a price_update can arrive
      // and populate live fields before this resolves, so blowing away
      // existing rows here would discard ticks the table already has.
      const next: PortfolioState = {};
      for (const holding of action.holdings) {
        next[holding.ticker] = { ...state[holding.ticker], ...holding };
      }
      return next;
    }
    case "ADD_HOLDING": {
      // Upsert, not insert-only — mirrors POST /portfolio/add's own
      // semantics (main.py, commit 4): re-adding an existing ticker
      // updates its quantity/avg_cost rather than being rejected.
      const existing = state[action.holding.ticker];
      return { ...state, [action.holding.ticker]: { ...existing, ...action.holding } };
    }
    case "REMOVE_HOLDING": {
      if (!(action.ticker in state)) return state;
      const next = { ...state };
      delete next[action.ticker];
      return next;
    }
    case "PRICE_UPDATE": {
      const existing = state[action.update.ticker];
      // A tick for a ticker not currently in the table — e.g. it arrived
      // just after removal, before the unsubscribe took effect on the
      // backend. Dropping it here mirrors the backend's own stale-tick
      // handling (websocket_manager.py, commit 3).
      if (!existing) return state;
      const priceHistory = [...(existing.priceHistory ?? []), action.update.price].slice(-MAX_PRICE_HISTORY);
      return { ...state, [action.update.ticker]: { ...existing, ...action.update, priceHistory } };
    }
    default:
      return state;
  }
}

type WatchlistState = Record<string, WatchlistRow>;

type WatchlistAction =
  | { type: "SET_WATCHLIST"; items: WatchlistItem[] }
  | { type: "ADD_TICKER"; ticker: string }
  | { type: "REMOVE_TICKER"; ticker: string }
  | { type: "WATCHLIST_PRICE_UPDATE"; update: WatchlistPriceUpdate };

// A near-mirror of portfolioReducer above — same shape of problem (set
// from a fetch, optimistic add/remove, merge in live ticks) — kept as its
// own reducer rather than folded into portfolioReducer, since a watchlist
// entry and a holding are different enough types (no quantity/avg_cost,
// no P&L) that a single combined state shape would need every consumer
// to check which kind of row it's looking at.
function watchlistReducer(state: WatchlistState, action: WatchlistAction): WatchlistState {
  switch (action.type) {
    case "SET_WATCHLIST": {
      const next: WatchlistState = {};
      for (const item of action.items) {
        next[item.ticker] = { ...state[item.ticker], ...item };
      }
      return next;
    }
    case "ADD_TICKER": {
      // Optimistic: unlike an alert (server-generated id), a watchlist
      // entry's only identity is the ticker itself, which the client
      // already knows before the request completes.
      if (action.ticker in state) return state;
      return { ...state, [action.ticker]: { ticker: action.ticker } };
    }
    case "REMOVE_TICKER": {
      if (!(action.ticker in state)) return state;
      const next = { ...state };
      delete next[action.ticker];
      return next;
    }
    case "WATCHLIST_PRICE_UPDATE": {
      const existing = state[action.update.ticker];
      // Same stale-tick guard as PRICE_UPDATE above, for the same reason.
      if (!existing) return state;
      const priceHistory = [...(existing.priceHistory ?? []), action.update.price].slice(-MAX_PRICE_HISTORY);
      return { ...state, [action.update.ticker]: { ...existing, ...action.update, priceHistory } };
    }
    default:
      return state;
  }
}

export default function Home() {
  const ready = useRequireAuth();
  const [portfolio, dispatch] = useReducer(portfolioReducer, {});
  const [watchlist, watchlistDispatch] = useReducer(watchlistReducer, {});
  const [news, setNews] = useState<NewsItem[]>([]);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // The browser WebSocket API can't set an Authorization header, so the
  // token travels as a query param instead (backend/main.py's /ws route
  // reads it from there) — see commit 20's decision log for why.
  const { lastMessage } = useWebSocket(`${WS_URL}?token=${getToken() ?? ""}`);

  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/portfolio`)
      .then((res) => {
        // A non-OK response (e.g. 401/403 before authFetch's redirect
        // takes effect — window.location.href doesn't halt JS execution,
        // so this chain keeps running for a moment) must not be parsed
        // as if it were the holdings array: the error body is a JSON
        // object like {"detail": "..."}, and dispatching that as
        // `holdings` crashes portfolioReducer's `for...of` with "not
        // iterable". Throwing here routes it to .catch() instead.
        if (!res.ok) throw new Error(`GET /portfolio failed: ${res.status}`);
        return res.json();
      })
      .then((holdings: HoldingWithPrice[]) => {
        if (!cancelled) dispatch({ type: "SET_HOLDINGS", holdings });
      })
      .catch(() => {
        // Swallow — the table just stays empty until the next successful
        // fetch or an add. Nothing actionable to do client-side here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/watchlist`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /watchlist failed: ${res.status}`);
        return res.json();
      })
      .then((items: WatchlistItem[]) => {
        if (!cancelled) watchlistDispatch({ type: "SET_WATCHLIST", items });
      })
      .catch(() => {
        // Same as the portfolio fetch above — stays empty until the next
        // successful load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/alerts`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /alerts failed: ${res.status}`);
        return res.json();
      })
      .then((data: PriceAlert[]) => {
        if (!cancelled) setAlerts(data);
      })
      .catch(() => {
        // Same as the portfolio fetch above — alerts just stay empty
        // until the next successful load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "price_update") {
      dispatch({ type: "PRICE_UPDATE", update: lastMessage });
    } else if (lastMessage.type === "watchlist_price_update") {
      watchlistDispatch({ type: "WATCHLIST_PRICE_UPDATE", update: lastMessage });
    } else if (lastMessage.type === "news_update") {
      setNews((prev) => [lastMessage, ...prev].slice(0, MAX_NEWS_ITEMS));
    } else if (lastMessage.type === "price_alert") {
      const { id, ticker, target_price, price, direction } = lastMessage;
      setAlerts((prev) => prev.map((alert) => (alert.id === id ? { ...alert, triggered: true } : alert)));
      setToasts((prev) => [
        ...prev,
        {
          id,
          text: `${ticker} crossed ${direction} ${formatCurrency(target_price)} (now ${formatCurrency(price)})`,
        },
      ]);
    }
  }, [lastMessage]);

  function handleAdd(holding: Holding) {
    dispatch({ type: "ADD_HOLDING", holding });
    authFetch(`${API_URL}/portfolio/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(holding),
    })
      .then((res) => {
        // Unlike a failed DELETE (commit 7), a failed ADD leaves a row
        // that will never receive price updates — it's not just stale,
        // it's permanently frozen at "—". Worth rolling back explicitly
        // rather than waiting for a refetch that may never come.
        if (!res.ok) dispatch({ type: "REMOVE_HOLDING", ticker: holding.ticker });
      })
      .catch(() => dispatch({ type: "REMOVE_HOLDING", ticker: holding.ticker }));
  }

  async function handleRemove(ticker: string) {
    dispatch({ type: "REMOVE_HOLDING", ticker });
    setAlerts((prev) => prev.filter((alert) => alert.ticker !== ticker));
    try {
      await authFetch(`${API_URL}/portfolio/${ticker}`, { method: "DELETE" });
    } catch {
      // The optimistic removal already updated the UI; a failed DELETE
      // will just mean the ticker reappears on the next full refetch.
    }
  }

  function handleAddToWatchlist(ticker: string) {
    watchlistDispatch({ type: "ADD_TICKER", ticker });
    authFetch(`${API_URL}/watchlist/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    })
      .then((res) => {
        // Same reasoning as handleAdd (commit 7): a failed add leaves a
        // row that will never receive a price tick if left in place.
        if (!res.ok) watchlistDispatch({ type: "REMOVE_TICKER", ticker });
      })
      .catch(() => watchlistDispatch({ type: "REMOVE_TICKER", ticker }));
  }

  async function handleRemoveFromWatchlist(ticker: string) {
    watchlistDispatch({ type: "REMOVE_TICKER", ticker });
    try {
      await authFetch(`${API_URL}/watchlist/${ticker}`, { method: "DELETE" });
    } catch {
      // Optimistic removal already updated the UI; a failed DELETE just
      // means it reappears on the next watchlist refetch.
    }
  }

  async function handleSetAlert(ticker: string, targetPrice: number) {
    try {
      const res = await authFetch(`${API_URL}/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, target_price: targetPrice }),
      });
      if (!res.ok) return;
      const alert: PriceAlert = await res.json();
      // Not optimistic like handleAdd/handleRemove: the backend generates
      // the alert's id (a uuid4), so there's nothing valid to render
      // until the response comes back — an optimistic placeholder would
      // need a fake id that then has to be reconciled with the real one.
      setAlerts((prev) => [...prev, alert]);
    } catch {
      // Nothing was added to local state, so nothing to roll back.
    }
  }

  async function handleDeleteAlert(id: string) {
    setAlerts((prev) => prev.filter((alert) => alert.id !== id));
    try {
      await authFetch(`${API_URL}/alerts/${id}`, { method: "DELETE" });
    } catch {
      // Optimistic removal already updated the UI; a failed DELETE just
      // means it reappears on the next alerts refetch (there isn't one
      // on a timer today — same accepted tradeoff as handleRemove).
    }
  }

  // Rendered nothing until confirmed logged in, rather than gated
  // earlier — the hooks above still all need to run unconditionally on
  // every render (Rules of Hooks), so the gate can only take effect here.
  if (!ready) return null;

  const rows = Object.values(portfolio).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const watchlistRows = Object.values(watchlist).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const totalValue = rows.reduce((sum, row) => sum + (row.position_value ?? 0), 0);
  const totalPnl = rows.reduce((sum, row) => sum + (row.position_pnl ?? 0), 0);
  const totalCostBasis = rows.reduce((sum, row) => sum + row.avg_cost * row.quantity, 0);
  const totalPnlPct = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">PortfolioLive</h1>
          <div className="flex items-center gap-4">
            <Link
              href="/analytics"
              className="text-sm font-medium text-neutral-600 hover:underline dark:text-neutral-300"
            >
              Analytics →
            </Link>
            <button
              type="button"
              onClick={() => {
                clearToken();
                window.location.href = "/login";
              }}
              className="text-sm font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Log out
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          15-minute delayed prices via Alpaca (IEX feed, free tier).
        </p>
        <div className="mt-4 flex gap-8">
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Value</div>
            <div className="text-xl font-semibold tabular-nums">
              {rows.length > 0 ? formatCurrency(totalValue) : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Total P&amp;L</div>
            <div
              className={`text-xl font-semibold tabular-nums ${
                totalPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {rows.length > 0
                ? `${formatSignedCurrency(totalPnl)} (${formatPercent(totalPnlPct)})`
                : "—"}
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Holdings</h2>
            <AddTickerForm onAdd={handleAdd} />
            <PortfolioTable
              rows={rows}
              alerts={alerts}
              onRemove={handleRemove}
              onSetAlert={handleSetAlert}
              onDeleteAlert={handleDeleteAlert}
            />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Watchlist
            </h2>
            <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              Live prices and news, without counting toward your P&amp;L.
            </p>
            <WatchlistSection
              rows={watchlistRows}
              onAdd={handleAddToWatchlist}
              onRemove={handleRemoveFromWatchlist}
            />
          </section>
        </div>

        <aside>
          <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">News</h2>
          <NewsFeed
            items={news}
            tickers={[...rows.map((row) => row.ticker), ...watchlistRows.map((row) => row.ticker)]}
          />
        </aside>
      </div>

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </div>
  );
}
