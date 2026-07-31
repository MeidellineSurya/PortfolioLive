"use client";

import { useState, type FormEvent } from "react";
import MarketStatusBadge from "./MarketStatusBadge";
import PriceSparkline from "./PriceSparkline";
import type { WatchlistRow } from "@/lib/types";
import { formatCurrency, formatPercent, formatSignedCurrency } from "@/lib/format";

// Mirrors backend/models.py's TICKER_RE, same reasoning as AddTickerForm
// (commit 9): catch an obviously invalid ticker before a round trip.
const TICKER_RE = /^[A-Z]{1,5}(\.JK)?$/;

type WatchlistProps = {
  rows: WatchlistRow[];
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
};

export default function Watchlist({ rows, onAdd, onRemove }: WatchlistProps) {
  const [ticker, setTicker] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = ticker.trim().toUpperCase();
    if (!TICKER_RE.test(normalized)) {
      setError("Ticker must be 1-5 letters (e.g. TSLA or BBCA.JK).");
      return;
    }
    setError(null);
    onAdd(normalized);
    setTicker("");
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="watch-ticker" className="text-xs text-neutral-500 dark:text-neutral-400">
            Watch a ticker
          </label>
          <input
            id="watch-ticker"
            value={ticker}
            onChange={(event) => setTicker(event.target.value.toUpperCase())}
            placeholder="TSLA or BBCA.JK"
            maxLength={8}
            className="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm uppercase dark:border-neutral-700"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add
        </button>
        {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Not watching anything yet.</p>
      ) : (
        <>
          {/* Same reasoning as PortfolioTable.tsx: a 6-column table still
              needs horizontal scroll to reach Change/Change %/Remove on a
              phone, so it's hidden below sm in favor of the card list. */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="py-2 pr-4 font-medium">Ticker</th>
                  <th className="py-2 pr-4 font-medium">Price</th>
                  <th className="py-2 pr-4 font-medium">Trend</th>
                  <th className="py-2 pr-4 font-medium">Change</th>
                  <th className="py-2 pr-4 font-medium">Change %</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const hasLiveData = row.price !== undefined;
                  const currency = row.currency ?? "USD";
                  const changePositive = (row.change ?? 0) >= 0;
                  const changeColor = hasLiveData
                    ? changePositive
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                    : "";
                  return (
                    <tr
                      key={row.ticker}
                      className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                    >
                      <td className="py-2 pr-4 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {row.ticker}
                          <MarketStatusBadge currency={currency} />
                        </span>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {hasLiveData ? formatCurrency(row.price!, currency) : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <PriceSparkline prices={row.priceHistory ?? []} />
                      </td>
                      <td className={`py-2 pr-4 tabular-nums ${changeColor}`}>
                        {row.change !== undefined ? formatSignedCurrency(row.change, currency) : "—"}
                      </td>
                      <td className={`py-2 pr-4 tabular-nums ${changeColor}`}>
                        {row.change_pct !== undefined ? formatPercent(row.change_pct) : "—"}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onRemove(row.ticker)}
                          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
                          aria-label={`Remove ${row.ticker} from watchlist`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 sm:hidden">
            {rows.map((row) => (
              <WatchlistRowCard key={row.ticker} row={row} onRemove={onRemove} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WatchlistRowCard({ row, onRemove }: { row: WatchlistRow; onRemove: (ticker: string) => void }) {
  const hasLiveData = row.price !== undefined;
  const currency = row.currency ?? "USD";
  const changePositive = (row.change ?? 0) >= 0;
  const changeColor = hasLiveData
    ? changePositive
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400"
    : "text-neutral-400 dark:text-neutral-500";

  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 font-medium">
          {row.ticker}
          <MarketStatusBadge currency={currency} />
        </div>
        <div className="text-right">
          <div className="tabular-nums font-medium">{hasLiveData ? formatCurrency(row.price!, currency) : "—"}</div>
          <div className={`text-xs tabular-nums ${changeColor}`}>
            {row.change !== undefined && row.change_pct !== undefined
              ? `${formatSignedCurrency(row.change, currency)} (${formatPercent(row.change_pct)})`
              : "—"}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <PriceSparkline prices={row.priceHistory ?? []} />
      </div>

      <button
        type="button"
        onClick={() => onRemove(row.ticker)}
        className="mt-2 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
        aria-label={`Remove ${row.ticker} from watchlist`}
      >
        Remove
      </button>
    </div>
  );
}
