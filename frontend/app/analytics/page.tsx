"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AnalyticsResponse, PortfolioSnapshot } from "@/lib/types";
import { formatPercent, formatSignedCurrency } from "@/lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const HISTORY_DAYS = 30;
const POSITIVE_COLOR = "#10b981"; // emerald-500
const NEGATIVE_COLOR = "#ef4444"; // red-500

function formatAxisDate(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A ticker only has an entry in a given snapshot's `holdings` if it was
// actually held (and had a known price) at that point in time — filtering
// per-ticker rather than assuming every snapshot has every current
// holding means a recently-added ticker's chart just starts partway
// through the window instead of erroring on missing data.
function buildTickerSeries(history: PortfolioSnapshot[], ticker: string) {
  return history
    .filter((snapshot) => ticker in snapshot.holdings)
    .map((snapshot) => ({ timestamp: snapshot.timestamp, pnl_pct: snapshot.holdings[ticker].pnl_pct }));
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/analytics?days=${HISTORY_DAYS}`)
      .then((res) => res.json())
      .then((result: AnalyticsResponse) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chartData = (data?.history ?? []).map((snapshot) => ({
    timestamp: snapshot.timestamp,
    total_pnl_pct: snapshot.total_pnl_pct,
  }));

  // "Currently held" is defined by the latest snapshot, not "ever held
  // in this window" — consistent with the rest of the dashboard, which
  // only ever shows current holdings, not ones you've since sold.
  const latestSnapshot = data && data.history.length > 0 ? data.history[data.history.length - 1] : null;
  const currentTickers = latestSnapshot ? Object.keys(latestSnapshot.holdings).sort() : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <Link href="/" className="text-sm font-medium text-neutral-600 hover:underline dark:text-neutral-300">
          ← Dashboard
        </Link>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load analytics — try refreshing.</p>
      )}

      {!error && !data && <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>}

      {data && (
        <div className="space-y-8">
          <section className="flex gap-8">
            <div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Return (since inception)</div>
              <div
                className={`text-xl font-semibold tabular-nums ${
                  data.total_pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                }`}
              >
                {data.history.length > 0
                  ? `${formatSignedCurrency(data.total_pnl)} (${formatPercent(data.total_pnl_pct)})`
                  : "—"}
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Daily P&amp;L History ({HISTORY_DAYS}d)
            </h2>
            {chartData.length < 2 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Not enough history yet — snapshots are taken hourly, check back once a few have accumulated.
              </p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-neutral-200 dark:stroke-neutral-800" />
                    <XAxis
                      dataKey="timestamp"
                      tickFormatter={formatAxisDate}
                      tick={{ fontSize: 12 }}
                      stroke="currentColor"
                      className="text-neutral-500 dark:text-neutral-400"
                    />
                    <YAxis
                      tickFormatter={(value: number) => `${value.toFixed(1)}%`}
                      tick={{ fontSize: 12 }}
                      stroke="currentColor"
                      className="text-neutral-500 dark:text-neutral-400"
                    />
                    <Tooltip
                      formatter={(value) => [`${Number(value).toFixed(2)}%`, "Total P&L"]}
                      labelFormatter={(label) => new Date(String(label)).toLocaleString()}
                    />
                    <Line
                      type="monotone"
                      dataKey="total_pnl_pct"
                      stroke="#10b981"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Best / Worst Performer (7d)
            </h2>
            {!data.best_performer_7d && !data.worst_performer_7d ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Not enough history yet — this needs at least two snapshots spanning the last 7 days.
              </p>
            ) : (
              <div className="flex gap-8">
                {data.best_performer_7d && (
                  <div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">Best</div>
                    <div className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {data.best_performer_7d.ticker} {formatPercent(data.best_performer_7d.change_pct)}
                    </div>
                  </div>
                )}
                {data.worst_performer_7d && (
                  <div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">Worst</div>
                    <div className="text-lg font-semibold tabular-nums text-red-600 dark:text-red-400">
                      {data.worst_performer_7d.ticker} {formatPercent(data.worst_performer_7d.change_pct)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              By Holding ({HISTORY_DAYS}d)
            </h2>
            {currentTickers.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No holdings with history yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                {currentTickers.map((ticker) => {
                  const series = buildTickerSeries(data.history, ticker);
                  const color =
                    series.length > 0 && series[series.length - 1].pnl_pct < 0 ? NEGATIVE_COLOR : POSITIVE_COLOR;
                  return (
                    <div key={ticker}>
                      <div className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">{ticker}</div>
                      {series.length < 2 ? (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">Not enough history yet.</p>
                      ) : (
                        <div className="h-40">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={series}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                className="stroke-neutral-200 dark:stroke-neutral-800"
                              />
                              <XAxis
                                dataKey="timestamp"
                                tickFormatter={formatAxisDate}
                                tick={{ fontSize: 10 }}
                                stroke="currentColor"
                                className="text-neutral-500 dark:text-neutral-400"
                              />
                              <YAxis
                                tickFormatter={(value: number) => `${value.toFixed(1)}%`}
                                tick={{ fontSize: 10 }}
                                stroke="currentColor"
                                className="text-neutral-500 dark:text-neutral-400"
                              />
                              <Tooltip
                                formatter={(value) => [`${Number(value).toFixed(2)}%`, ticker]}
                                labelFormatter={(label) => new Date(String(label)).toLocaleString()}
                              />
                              <Line
                                type="monotone"
                                dataKey="pnl_pct"
                                stroke={color}
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
