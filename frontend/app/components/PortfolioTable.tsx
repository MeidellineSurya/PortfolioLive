"use client";

import { useState, type FormEvent } from "react";
import MarketStatusBadge from "./MarketStatusBadge";
import PriceSparkline from "./PriceSparkline";
import type { NewsItem, PortfolioRow, PriceAlert } from "@/lib/types";
import { formatCurrency, formatPercent, formatSignedCurrency } from "@/lib/format";

type PortfolioTableProps = {
  rows: PortfolioRow[];
  alerts: PriceAlert[];
  newsByTicker: Record<string, NewsItem[]>;
  onRemove: (ticker: string) => void;
  onSetAlert: (ticker: string, targetPrice: number) => void;
  onDeleteAlert: (id: string) => void;
};

export default function PortfolioTable({
  rows,
  alerts,
  newsByTicker,
  onRemove,
  onSetAlert,
  onDeleteAlert,
}: PortfolioTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No holdings yet — add a ticker to get started.
      </p>
    );
  }

  return (
    <>
      {/* A 10-column table doesn't fit a phone screen without horizontal
          scrolling past the P&L/Alert/Remove columns — hidden below sm
          in favor of the stacked card list, which carries the same data
          and handlers through a separate component rather than trying
          to make one markup serve both a <tr> and a card <div> (a
          <tbody> can only contain <tr> children). */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <th className="py-2 pr-4 font-medium">Ticker</th>
              <th className="py-2 pr-4 font-medium">Qty</th>
              <th className="py-2 pr-4 font-medium">Avg Cost</th>
              <th className="py-2 pr-4 font-medium">Current Price</th>
              <th className="py-2 pr-4 font-medium">Trend</th>
              <th className="py-2 pr-4 font-medium">Value</th>
              <th className="py-2 pr-4 font-medium">P&amp;L ($)</th>
              <th className="py-2 pr-4 font-medium">P&amp;L (%)</th>
              <th className="py-2 pr-4 font-medium">Alert</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PortfolioRowView
                key={row.ticker}
                row={row}
                alerts={alerts.filter((alert) => alert.ticker === row.ticker)}
                news={newsByTicker[row.ticker] ?? []}
                onRemove={onRemove}
                onSetAlert={onSetAlert}
                onDeleteAlert={onDeleteAlert}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 sm:hidden">
        {rows.map((row) => (
          <PortfolioRowCard
            key={row.ticker}
            row={row}
            alerts={alerts.filter((alert) => alert.ticker === row.ticker)}
            news={newsByTicker[row.ticker] ?? []}
            onRemove={onRemove}
            onSetAlert={onSetAlert}
            onDeleteAlert={onDeleteAlert}
          />
        ))}
      </div>
    </>
  );
}

function PortfolioRowView({
  row,
  alerts,
  news,
  onRemove,
  onSetAlert,
  onDeleteAlert,
}: {
  row: PortfolioRow;
  alerts: PriceAlert[];
  news: NewsItem[];
  onRemove: (ticker: string) => void;
  onSetAlert: (ticker: string, targetPrice: number) => void;
  onDeleteAlert: (id: string) => void;
}) {
  const [addingAlert, setAddingAlert] = useState(false);
  const [targetPrice, setTargetPrice] = useState("");
  const hasLiveData = row.price !== undefined;
  const pnlPositive = (row.position_pnl ?? 0) >= 0;
  const currency = row.currency ?? "USD";

  function handleSubmitAlert(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(targetPrice);
    if (!(parsed > 0)) return;
    onSetAlert(row.ticker, parsed);
    setTargetPrice("");
    setAddingAlert(false);
  }

  return (
    <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
      <td className="py-2 pr-4 font-medium">
        <span className="inline-flex items-center gap-1.5">
          {row.ticker}
          <MarketStatusBadge currency={currency} />
        </span>
      </td>
      <td className="py-2 pr-4 tabular-nums">{row.quantity}</td>
      <td className="py-2 pr-4 tabular-nums">{formatCurrency(row.avg_cost, currency)}</td>
      <td className="py-2 pr-4 tabular-nums">
        {hasLiveData ? formatCurrency(row.price!, currency) : "—"}
      </td>
      <td className="py-2 pr-4">
        <PriceSparkline prices={row.priceHistory ?? []} news={news} />
      </td>
      <td className="py-2 pr-4 tabular-nums">
        {row.position_value !== undefined ? formatCurrency(row.position_value, currency) : "—"}
      </td>
      <td
        className={`py-2 pr-4 tabular-nums ${
          hasLiveData ? (pnlPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400") : ""
        }`}
      >
        {row.position_pnl !== undefined ? formatSignedCurrency(row.position_pnl, currency) : "—"}
      </td>
      <td
        className={`py-2 pr-4 tabular-nums ${
          hasLiveData ? (pnlPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400") : ""
        }`}
      >
        {row.position_pnl_pct !== undefined ? formatPercent(row.position_pnl_pct) : "—"}
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-wrap items-center gap-1">
          {alerts.map((alert) => (
            <span
              key={alert.id}
              title={alert.triggered ? "Already fired" : "Watching for this price"}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                alert.triggered
                  ? "bg-neutral-50 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-500"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              <span aria-hidden>{alert.triggered ? "✓" : "🔔"}</span>
              {formatCurrency(alert.target_price, currency)}
              <button
                type="button"
                onClick={() => onDeleteAlert(alert.id)}
                aria-label={`Remove ${alert.triggered ? "fired" : "pending"} alert for ${row.ticker} at ${formatCurrency(alert.target_price, currency)}`}
                className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
              >
                ×
              </button>
            </span>
          ))}
          {addingAlert ? (
            <form onSubmit={handleSubmitAlert} className="flex items-center gap-1">
              <input
                autoFocus
                type="number"
                min="0"
                step="any"
                value={targetPrice}
                onChange={(event) => setTargetPrice(event.target.value)}
                onBlur={() => {
                  if (!targetPrice) setAddingAlert(false);
                }}
                placeholder="Price"
                className="w-16 rounded border border-neutral-300 bg-transparent px-1 py-0.5 text-xs dark:border-neutral-700"
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAddingAlert(true)}
              aria-label={`Set price alert for ${row.ticker}`}
              className="rounded px-1 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              🔔+
            </button>
          )}
        </div>
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={() => onRemove(row.ticker)}
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
          aria-label={`Remove ${row.ticker}`}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

// Same data and handlers as PortfolioRowView, restructured for a narrow
// screen — ticker/price/P&L prominent up top (what you actually glance
// at), sparkline, then alerts + remove. Own copy of the small
// addingAlert/targetPrice form state rather than sharing a hook with
// PortfolioRowView: both are mounted at once (CSS hidden/shown per
// breakpoint, not conditionally rendered), so sharing state would mean
// one row's two markups fighting over a single "is the alert form open"
// flag.
function PortfolioRowCard({
  row,
  alerts,
  news,
  onRemove,
  onSetAlert,
  onDeleteAlert,
}: {
  row: PortfolioRow;
  alerts: PriceAlert[];
  news: NewsItem[];
  onRemove: (ticker: string) => void;
  onSetAlert: (ticker: string, targetPrice: number) => void;
  onDeleteAlert: (id: string) => void;
}) {
  const [addingAlert, setAddingAlert] = useState(false);
  const [targetPrice, setTargetPrice] = useState("");
  const hasLiveData = row.price !== undefined;
  const hasPnl = row.position_pnl !== undefined && row.position_pnl_pct !== undefined;
  const pnlPositive = (row.position_pnl ?? 0) >= 0;
  const currency = row.currency ?? "USD";
  const pnlColor = hasPnl
    ? pnlPositive
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400"
    : "text-neutral-400 dark:text-neutral-500";

  function handleSubmitAlert(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(targetPrice);
    if (!(parsed > 0)) return;
    onSetAlert(row.ticker, parsed);
    setTargetPrice("");
    setAddingAlert(false);
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="inline-flex items-center gap-1.5 font-medium">
            {row.ticker}
            <MarketStatusBadge currency={currency} />
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {row.quantity} sh · {formatCurrency(row.avg_cost, currency)} avg
          </div>
        </div>
        <div className="text-right">
          <div className="tabular-nums font-medium">{hasLiveData ? formatCurrency(row.price!, currency) : "—"}</div>
          <div className={`text-xs tabular-nums ${pnlColor}`}>
            {hasPnl
              ? `${formatSignedCurrency(row.position_pnl!, currency)} (${formatPercent(row.position_pnl_pct!)})`
              : "—"}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <PriceSparkline prices={row.priceHistory ?? []} news={news} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {alerts.map((alert) => (
          <span
            key={alert.id}
            title={alert.triggered ? "Already fired" : "Watching for this price"}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
              alert.triggered
                ? "bg-neutral-50 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-500"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            <span aria-hidden>{alert.triggered ? "✓" : "🔔"}</span>
            {formatCurrency(alert.target_price, currency)}
            <button
              type="button"
              onClick={() => onDeleteAlert(alert.id)}
              aria-label={`Remove ${alert.triggered ? "fired" : "pending"} alert for ${row.ticker} at ${formatCurrency(alert.target_price, currency)}`}
              className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
            >
              ×
            </button>
          </span>
        ))}
        {addingAlert ? (
          <form onSubmit={handleSubmitAlert} className="flex items-center gap-1">
            <input
              autoFocus
              type="number"
              min="0"
              step="any"
              value={targetPrice}
              onChange={(event) => setTargetPrice(event.target.value)}
              onBlur={() => {
                if (!targetPrice) setAddingAlert(false);
              }}
              placeholder="Price"
              className="w-16 rounded border border-neutral-300 bg-transparent px-1 py-0.5 text-xs dark:border-neutral-700"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAddingAlert(true)}
            aria-label={`Set price alert for ${row.ticker}`}
            className="rounded px-1 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            🔔+
          </button>
        )}
        <button
          type="button"
          onClick={() => onRemove(row.ticker)}
          className="ml-auto rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
          aria-label={`Remove ${row.ticker}`}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
