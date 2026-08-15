"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useState } from "react";

import AddTickerForm from "./components/AddTickerForm";
import NewsFeed from "./components/NewsFeed";
import NotificationToggle from "./components/NotificationToggle";
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
import { currencyForTicker } from "@/lib/types";
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
      // currency isn't part of Holding (POST's request body) — without
      // this, a freshly-added row has no currency until its first
      // PRICE_UPDATE tick arrives, and formatCurrency's `?? "USD"`
      // fallback would render an IDX ticker's avg cost in dollars for
      // however long that takes (up to 20s for a Yahoo-polled ticker,
      // not near-instant like Alpaca's push). Same optimistic-placeholder
      // reasoning as ADD_TICKER below.
      return {
        ...state,
        [action.holding.ticker]: {
          ...existing,
          ...action.holding,
          currency: currencyForTicker(action.holding.ticker),
        },
      };
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
      const priceHistory = [
        ...(existing.priceHistory ?? []),
        { price: action.update.price, timestamp: action.update.timestamp },
      ].slice(-MAX_PRICE_HISTORY);
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
      return { ...state, [action.ticker]: { ticker: action.ticker, currency: currencyForTicker(action.ticker) } };
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
      const priceHistory = [
        ...(existing.priceHistory ?? []),
        { price: action.update.price, timestamp: action.update.timestamp },
      ].slice(-MAX_PRICE_HISTORY);
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
  // Grouped by ticker for PriceSparkline's chart-annotation markers —
  // `news` itself stays a flat, most-recent-first list (that's what
  // NewsFeed wants), this is a derived view for a different consumer.
  const newsByTicker = useMemo(() => {
    const map: Record<string, NewsItem[]> = {};
    for (const item of news) {
      (map[item.ticker] ??= []).push(item);
    }
    return map;
  }, [news]);
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

  // App icon badge (Chrome/Edge desktop + Android only — the Badging
  // API has no Safari/iOS support). Count = fired-but-not-yet-deleted
  // alerts, reusing the delete button that already exists in the alert
  // UI rather than inventing a separate "acknowledge" concept — removing
  // a fired alert already doubles as clearing it from the badge.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const triggeredCount = alerts.filter((alert) => alert.triggered).length;
    if (triggeredCount > 0) {
      navigator.setAppBadge(triggeredCount).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }, [alerts]);

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
      if (!res.ok) {
        // A silent `return` here used to mean a failed alert looked
        // identical to a successful one from the user's side — the
        // input just closes either way (PortfolioTable's
        // handleSubmitAlert doesn't wait to find out). Surface *why*
        // rather than nothing: the backend sends a real reason (e.g.
        // "not in your portfolio or watchlist") as JSON on a 4xx, worth
        // showing over a generic failure message when it's there.
        let detail = `Couldn't set an alert for ${ticker}.`;
        try {
          const body: { detail?: string } = await res.json();
          if (body.detail) detail = body.detail;
        } catch {
          // Response wasn't JSON (e.g. a 502 from an infrastructure
          // problem, not the app itself) — the generic message stands.
        }
        setToasts((prev) => [...prev, { id: crypto.randomUUID(), text: detail }]);
        return;
      }
      const alert: PriceAlert = await res.json();
      // Not optimistic like handleAdd/handleRemove: the backend generates
      // the alert's id (a uuid4), so there's nothing valid to render
      // until the response comes back — an optimistic placeholder would
      // need a fake id that then has to be reconciled with the real one.
      setAlerts((prev) => [...prev, alert]);
    } catch {
      // fetch itself threw — the backend was unreachable (e.g. down or
      // between deploys), not just an application-level rejection.
      setToasts((prev) => [
        ...prev,
        { id: crypto.randomUUID(), text: `Couldn't reach the server to set an alert for ${ticker}.` },
      ]);
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

  // Segregated by currency, not summed into one number — a $ total and
  // an Rp total can't be added together without an FX conversion this
  // app deliberately doesn't do (see DECISION_LOG). USD is listed first
  // when present since it's the app's original/primary currency; any
  // other currency present follows in whatever order it first appears.
  const totalsByCurrency = new Map<string, { value: number; pnl: number; costBasis: number }>();
  for (const row of rows) {
    const currency = row.currency ?? "USD";
    const bucket = totalsByCurrency.get(currency) ?? { value: 0, pnl: 0, costBasis: 0 };
    bucket.value += row.position_value ?? 0;
    bucket.pnl += row.position_pnl ?? 0;
    bucket.costBasis += row.avg_cost * row.quantity;
    totalsByCurrency.set(currency, bucket);
  }
  const currencyOrder = ["USD", ...[...totalsByCurrency.keys()].filter((c) => c !== "USD")].filter((c) =>
    totalsByCurrency.has(c)
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-y-2">
          <h1 className="text-2xl font-semibold">PortfolioLive</h1>
          <div className="flex items-center gap-4">
            <NotificationToggle onNotify={(text) => setToasts((prev) => [...prev, { id: crypto.randomUUID(), text }])} />
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
          Real-time IEX exchange prices via Alpaca (free tier — not the consolidated
          NBBO, so prices can differ slightly from other quote sources); Indonesia
          (.JK) tickers via Yahoo Finance.
        </p>
        <div className="mt-4 flex flex-wrap gap-8">
          {rows.length === 0 ? (
            <div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Value</div>
              <div className="text-xl font-semibold tabular-nums">—</div>
            </div>
          ) : (
            currencyOrder.map((currency) => {
              const bucket = totalsByCurrency.get(currency)!;
              const totalPnlPct = bucket.costBasis > 0 ? (bucket.pnl / bucket.costBasis) * 100 : 0;
              return (
                <div key={currency} className="flex gap-8">
                  <div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Value · {currency}</div>
                    <div className="text-xl font-semibold tabular-nums">
                      {formatCurrency(bucket.value, currency as "USD" | "IDR")}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">Total P&amp;L · {currency}</div>
                    <div
                      className={`text-xl font-semibold tabular-nums ${
                        bucket.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {formatSignedCurrency(bucket.pnl, currency as "USD" | "IDR")} ({formatPercent(totalPnlPct)})
                    </div>
                  </div>
                </div>
              );
            })
          )}
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
              newsByTicker={newsByTicker}
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
              newsByTicker={newsByTicker}
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
