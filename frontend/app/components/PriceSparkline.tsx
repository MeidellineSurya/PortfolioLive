"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import type { PricePoint } from "@/lib/types";

const POSITIVE_COLOR = "#10b981"; // emerald-500
const NEGATIVE_COLOR = "#ef4444"; // red-500

type PriceSparklineProps = {
  prices: PricePoint[];
};

export default function PriceSparkline({ prices }: PriceSparklineProps) {
  if (prices.length < 2) {
    return <div className="h-8 w-24 text-xs text-neutral-400 dark:text-neutral-600">—</div>;
  }

  // Colored by the trend *within this window* (first vs. last of the last
  // 20 ticks) — deliberately independent of the P&L column's color, which
  // reflects total gain/loss since purchase. A holding can be down overall
  // but ticking up right now; the sparkline is about recent movement, not
  // position performance.
  const isUp = prices[prices.length - 1].price >= prices[0].price;
  const color = isUp ? POSITIVE_COLOR : NEGATIVE_COLOR;
  const data = prices.map((p, index) => ({ index, price: p.price }));

  // A plain dataMin/dataMax domain always stretches to exactly fit
  // whatever range is in the current window, so a few cents of ordinary
  // bid/ask noise on e.g. a $300 stock fills this 32px-tall chart just as
  // dramatically as a genuine multi-percent move would — that's most of
  // what reads as "jumping a lot" even after the backend picks a
  // deterministic midpoint price per tick. Flooring the domain at a
  // fixed 0.1% of the latest price gives sub-noise-level fluctuations a
  // stable, non-dramatic baseline, while any real move bigger than that
  // still scales the chart normally.
  const latest = prices[prices.length - 1].price;
  const rawMin = Math.min(...prices.map((p) => p.price));
  const rawMax = Math.max(...prices.map((p) => p.price));
  const minRange = latest * 0.001;
  const pad = Math.max(0, (minRange - (rawMax - rawMin)) / 2);
  const domain: [number, number] = [rawMin - pad, rawMax + pad];

  return (
    <div className="h-8 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis domain={domain} hide />
          <Line
            type="monotone"
            dataKey="price"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
