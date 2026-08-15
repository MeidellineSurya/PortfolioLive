"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { authFetch, useRequireAuth } from "@/lib/auth";
import type { AnalyticsResponse, Currency, PortfolioSnapshot } from "@/lib/types";
import { currencyForTicker } from "@/lib/types";
import { formatPercent, formatSignedCurrency } from "@/lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const HISTORY_DAYS = 30;
const POSITIVE_COLOR = "#10b981"; // emerald-500
const NEGATIVE_COLOR = "#ef4444"; // red-500
const TOTAL_COLOR = "#a3a3a3"; // neutral-400 — distinguishes Start/End totals from per-ticker contributions

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

// Same "only include snapshots that actually have this key" reasoning as
// buildTickerSeries above, one level up: a currency with no holdings at
// a given point in the window (e.g. before the first IDR holding was
// added) simply has no entry in that snapshot's `totals`.
function buildCurrencySeries(history: PortfolioSnapshot[], currency: string) {
  return history
    .filter((snapshot) => currency in snapshot.totals)
    .map((snapshot) => ({ timestamp: snapshot.timestamp, total_pnl_pct: snapshot.totals[currency].total_pnl_pct }));
}

type WaterfallRow = {
  label: string;
  base: number;
  value: number;
  isPositive: boolean;
  isTotal?: boolean;
  status?: "new" | "closed";
};

// Diffs each holding's `value` between the first and last snapshot in the
// window. This is a *net value change* — price moves and any buys/sells
// combined — not pure price attribution, since HoldingSnapshot stores no
// quantity to separate the two. Labeled as such in the UI rather than
// "price contribution". Because a snapshot's total_value is literally the
// sum of that snapshot's holding values, startTotal + sum(deltas) ==
// endTotal exactly (barring float rounding) — no "other" bar needed.
function buildWaterfallData(history: PortfolioSnapshot[], currency: Currency): WaterfallRow[] {
  if (history.length < 2) return [];
  const earliest = history[0];
  const latest = history[history.length - 1];
  const startTotal = earliest.totals[currency]?.total_value ?? 0;
  if (!(currency in earliest.totals) && !(currency in latest.totals)) return [];

  const tickers = new Set(
    [...Object.keys(earliest.holdings), ...Object.keys(latest.holdings)].filter(
      (ticker) => currencyForTicker(ticker) === currency
    )
  );

  const deltas = [...tickers]
    .map((ticker) => {
      const startValue = earliest.holdings[ticker]?.value ?? 0;
      const endValue = latest.holdings[ticker]?.value ?? 0;
      const status = !(ticker in earliest.holdings)
        ? ("new" as const)
        : !(ticker in latest.holdings)
          ? ("closed" as const)
          : undefined;
      return { ticker, delta: endValue - startValue, status };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let running = startTotal;
  const rows: WaterfallRow[] = [{ label: "Start", base: 0, value: startTotal, isPositive: true, isTotal: true }];
  for (const { ticker, delta, status } of deltas) {
    const base = Math.min(running, running + delta);
    rows.push({ label: ticker, base, value: Math.abs(delta), isPositive: delta >= 0, status });
    running += delta;
  }
  rows.push({ label: "End", base: 0, value: running, isPositive: true, isTotal: true });
  return rows;
}

// Recharts' <Cell> is deprecated in favour of a custom `shape` on <Bar> —
// this renders each bar's fill based on its own datum (positive/negative
// contribution vs. a neutral Start/End total) rather than one fixed color
// for the whole series. `payload` is typed `any` by Recharts itself.
function WaterfallBarShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: unknown }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  const row = payload as WaterfallRow;
  const fill = row.isTotal ? TOTAL_COLOR : row.isPositive ? POSITIVE_COLOR : NEGATIVE_COLOR;
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />;
}

function WaterfallTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: WaterfallRow }>;
  currency: Currency;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs shadow dark:border-neutral-700 dark:bg-neutral-900">
      <div className="font-medium">{row.label}</div>
      {!row.isTotal && (
        <div className={row.isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
          {formatSignedCurrency(row.isPositive ? row.value : -row.value, currency)}
          {row.status === "new" && " · new this window"}
          {row.status === "closed" && " · closed this window"}
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const ready = useRequireAuth();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/analytics?days=${HISTORY_DAYS}`)
      .then((res) => {
        // Same reasoning as page.tsx's data-fetch effects: a non-OK
        // response's body is an error object, not an AnalyticsResponse —
        // parsing it as one would set `data` to something that doesn't
        // match the shape every render below assumes.
        if (!res.ok) throw new Error(`GET /analytics failed: ${res.status}`);
        return res.json();
      })
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

  if (!ready) return null;

  // "Currently held" is defined by the latest snapshot, not "ever held
  // in this window" — consistent with the rest of the dashboard, which
  // only ever shows current holdings, not ones you've since sold.
  const latestSnapshot = data && data.history.length > 0 ? data.history[data.history.length - 1] : null;
  const currentTickers = latestSnapshot ? Object.keys(latestSnapshot.holdings).sort() : [];

  // Segregated by currency, not summed into one number — same reasoning
  // as the dashboard header (page.tsx): a $ total and an Rp total can't
  // be added without an FX conversion this app deliberately doesn't do.
  // USD listed first when present, same ordering convention as the
  // dashboard.
  const currencies = data
    ? ["USD", ...Object.keys(data.totals).filter((c) => c !== "USD")].filter((c) => c in data.totals)
    : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-y-2">
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
          <section className="flex flex-wrap gap-8">
            {currencies.length === 0 ? (
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Return (since inception)</div>
                <div className="text-xl font-semibold tabular-nums">—</div>
              </div>
            ) : (
              currencies.map((currency) => {
                const totals = data.totals[currency];
                return (
                  <div key={currency}>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      Total Return · {currency} (since inception)
                    </div>
                    <div
                      className={`text-xl font-semibold tabular-nums ${
                        totals.total_pnl >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {formatSignedCurrency(totals.total_pnl, currency as Currency)} (
                      {formatPercent(totals.total_pnl_pct)})
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Daily P&amp;L History ({HISTORY_DAYS}d)
            </h2>
            {currencies.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Not enough history yet — snapshots are taken hourly, check back once a few have accumulated.
              </p>
            ) : (
              <div className="space-y-6">
                {currencies.map((currency) => {
                  const series = buildCurrencySeries(data.history, currency);
                  return (
                    <div key={currency}>
                      <div className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        {currency}
                      </div>
                      {series.length < 2 ? (
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          Not enough history yet — snapshots are taken hourly, check back once a few have
                          accumulated.
                        </p>
                      ) : (
                        <div className="h-64">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={series}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                className="stroke-neutral-200 dark:stroke-neutral-800"
                              />
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
                    </div>
                  );
                })}
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
              Contribution to Value Change ({HISTORY_DAYS}d)
            </h2>
            <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              Reflects each holding&apos;s net change in value over this window — including any buys or
              sells, not price movement alone.
            </p>
            {currencies.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Not enough history yet — snapshots are taken hourly, check back once a few have accumulated.
              </p>
            ) : (
              <div className="space-y-6">
                {currencies.map((currency) => {
                  const rows = buildWaterfallData(data.history, currency as Currency);
                  return (
                    <div key={currency}>
                      <div className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        {currency}
                      </div>
                      {rows.length === 0 ? (
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          Not enough history yet — snapshots are taken hourly, check back once a few have
                          accumulated.
                        </p>
                      ) : (
                        <div className="h-64">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={rows}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                className="stroke-neutral-200 dark:stroke-neutral-800"
                              />
                              <XAxis
                                dataKey="label"
                                tick={{ fontSize: 11 }}
                                stroke="currentColor"
                                className="text-neutral-500 dark:text-neutral-400"
                              />
                              <YAxis
                                tickFormatter={(value: number) => formatSignedCurrency(value, currency as Currency)}
                                tick={{ fontSize: 11 }}
                                stroke="currentColor"
                                className="text-neutral-500 dark:text-neutral-400"
                              />
                              <Tooltip content={<WaterfallTooltip currency={currency as Currency} />} />
                              <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
                              <Bar
                                dataKey="value"
                                stackId="wf"
                                isAnimationActive={false}
                                shape={WaterfallBarShape}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  );
                })}
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
