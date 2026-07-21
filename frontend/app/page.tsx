"use client";

import { useEffect, useReducer, useState } from "react";

import AddTickerForm from "./components/AddTickerForm";
import NewsFeed from "./components/NewsFeed";
import PortfolioTable from "./components/PortfolioTable";
import { useWebSocket } from "@/lib/websocket";
import type { Holding, NewsItem, PortfolioRow, PriceUpdate } from "@/lib/types";
import { formatCurrency, formatPercent, formatSignedCurrency } from "@/lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";
const MAX_NEWS_ITEMS = 20;

type PortfolioState = Record<string, PortfolioRow>;

type PortfolioAction =
  | { type: "SET_HOLDINGS"; holdings: Holding[] }
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
      return { ...state, [action.update.ticker]: { ...existing, ...action.update } };
    }
    default:
      return state;
  }
}

export default function Home() {
  const [portfolio, dispatch] = useReducer(portfolioReducer, {});
  const [news, setNews] = useState<NewsItem[]>([]);
  const { lastMessage } = useWebSocket(WS_URL);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/portfolio`)
      .then((res) => res.json())
      .then((holdings: Holding[]) => {
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
    if (!lastMessage) return;
    if (lastMessage.type === "price_update") {
      dispatch({ type: "PRICE_UPDATE", update: lastMessage });
    } else if (lastMessage.type === "news_update") {
      setNews((prev) => [lastMessage, ...prev].slice(0, MAX_NEWS_ITEMS));
    }
  }, [lastMessage]);

  function handleAdd(holding: Holding) {
    dispatch({ type: "ADD_HOLDING", holding });
    fetch(`${API_URL}/portfolio/add`, {
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
    try {
      await fetch(`${API_URL}/portfolio/${ticker}`, { method: "DELETE" });
    } catch {
      // The optimistic removal already updated the UI; a failed DELETE
      // will just mean the ticker reappears on the next full refetch.
    }
  }

  const rows = Object.values(portfolio).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const totalValue = rows.reduce((sum, row) => sum + (row.position_value ?? 0), 0);
  const totalPnl = rows.reduce((sum, row) => sum + (row.position_pnl ?? 0), 0);
  const totalCostBasis = rows.reduce((sum, row) => sum + row.avg_cost * row.quantity, 0);
  const totalPnlPct = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">PortfolioLive</h1>
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
        <section>
          <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Holdings</h2>
          <AddTickerForm onAdd={handleAdd} />
          <PortfolioTable rows={rows} onRemove={handleRemove} />
        </section>

        <aside>
          <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">News</h2>
          <NewsFeed items={news} />
        </aside>
      </div>
    </div>
  );
}
