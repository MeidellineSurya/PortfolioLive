"use client";

import type { PortfolioRow } from "@/lib/types";
import { formatCurrency, formatPercent, formatSignedCurrency } from "@/lib/format";

type PortfolioTableProps = {
  rows: PortfolioRow[];
  onRemove: (ticker: string) => void;
};

export default function PortfolioTable({ rows, onRemove }: PortfolioTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No holdings yet — add a ticker to get started.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th className="py-2 pr-4 font-medium">Ticker</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Avg Cost</th>
            <th className="py-2 pr-4 font-medium">Current Price</th>
            <th className="py-2 pr-4 font-medium">Value</th>
            <th className="py-2 pr-4 font-medium">P&amp;L ($)</th>
            <th className="py-2 pr-4 font-medium">P&amp;L (%)</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PortfolioRowView key={row.ticker} row={row} onRemove={onRemove} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortfolioRowView({
  row,
  onRemove,
}: {
  row: PortfolioRow;
  onRemove: (ticker: string) => void;
}) {
  const hasLiveData = row.price !== undefined;
  const pnlPositive = (row.position_pnl ?? 0) >= 0;

  return (
    <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
      <td className="py-2 pr-4 font-medium">{row.ticker}</td>
      <td className="py-2 pr-4 tabular-nums">{row.quantity}</td>
      <td className="py-2 pr-4 tabular-nums">{formatCurrency(row.avg_cost)}</td>
      <td className="py-2 pr-4 tabular-nums">
        {hasLiveData ? formatCurrency(row.price!) : "—"}
      </td>
      <td className="py-2 pr-4 tabular-nums">
        {row.position_value !== undefined ? formatCurrency(row.position_value) : "—"}
      </td>
      <td
        className={`py-2 pr-4 tabular-nums ${
          hasLiveData ? (pnlPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400") : ""
        }`}
      >
        {row.position_pnl !== undefined ? formatSignedCurrency(row.position_pnl) : "—"}
      </td>
      <td
        className={`py-2 pr-4 tabular-nums ${
          hasLiveData ? (pnlPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400") : ""
        }`}
      >
        {row.position_pnl_pct !== undefined ? formatPercent(row.position_pnl_pct) : "—"}
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
