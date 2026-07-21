"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

const POSITIVE_COLOR = "#10b981"; // emerald-500
const NEGATIVE_COLOR = "#ef4444"; // red-500

type PriceSparklineProps = {
  prices: number[];
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
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? POSITIVE_COLOR : NEGATIVE_COLOR;
  const data = prices.map((price, index) => ({ index, price }));

  return (
    <div className="h-8 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis domain={["dataMin", "dataMax"]} hide />
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
