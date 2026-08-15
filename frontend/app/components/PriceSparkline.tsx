"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Line, LineChart, ReferenceDot, ResponsiveContainer, YAxis } from "recharts";
import type { NewsItem, PricePoint } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

const POSITIVE_COLOR = "#10b981"; // emerald-500
const NEGATIVE_COLOR = "#ef4444"; // red-500

// How close a news article's published_at has to be to a price tick's
// timestamp to get marked on the chart. Ties "does this news show up on
// this chart" to "did this news happen while this chart's visible window
// was live" — a fixed pad rather than trying to guess a "correct" window,
// since a sparkline's real time-span varies a lot (Alpaca ticks can be
// sub-second apart; Yahoo-sourced (.JK) tickers are polled every 20s, so
// a 20-tick window there can already span several minutes on its own).
const CORRELATION_PAD_MS = 2 * 60 * 1000;

type PriceSparklineProps = {
  prices: PricePoint[];
  news: NewsItem[];
};

type OpenPopover = { items: NewsItem[]; x: number; y: number };

// Groups eligible news items by the index of the price tick they're
// nearest to (in time) — multiple items can land on the same tick.
function buildMarkers(prices: PricePoint[], news: NewsItem[]): Record<number, NewsItem[]> {
  if (news.length === 0 || prices.length === 0) return {};
  const windowStart = new Date(prices[0].timestamp).getTime() - CORRELATION_PAD_MS;
  const windowEnd = new Date(prices[prices.length - 1].timestamp).getTime() + CORRELATION_PAD_MS;

  const markers: Record<number, NewsItem[]> = {};
  for (const item of news) {
    const publishedAt = new Date(item.published_at).getTime();
    if (Number.isNaN(publishedAt) || publishedAt < windowStart || publishedAt > windowEnd) continue;

    let nearestIndex = 0;
    let nearestDiff = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const diff = Math.abs(new Date(prices[i].timestamp).getTime() - publishedAt);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestIndex = i;
      }
    }
    (markers[nearestIndex] ??= []).push(item);
  }
  return markers;
}

export default function PriceSparkline({ prices, news }: PriceSparklineProps) {
  const [popover, setPopover] = useState<OpenPopover | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside click or Escape. The popover is portaled to
  // <body> (see the render below — a table cell's overflow-x-auto forces
  // overflow-y: auto too, silently clipping any ordinary absolutely-
  // positioned child), so "outside" has to check both the trigger
  // (wrapperRef) and the portaled popover itself (popoverRef), not just
  // one DOM subtree.
  useEffect(() => {
    if (!popover) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setPopover(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPopover(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [popover]);

  if (prices.length < 2) {
    return <div className="h-10 w-32 text-xs text-neutral-400 dark:text-neutral-600">—</div>;
  }

  // Colored by the trend *within this window* (first vs. last of the last
  // 20 ticks) — deliberately independent of the P&L column's color, which
  // reflects total gain/loss since purchase. A holding can be down overall
  // but ticking up right now; the sparkline is about recent movement, not
  // position performance.
  const isUp = prices[prices.length - 1].price >= prices[0].price;
  const color = isUp ? POSITIVE_COLOR : NEGATIVE_COLOR;
  const data = prices.map((p, index) => ({ index, price: p.price }));
  const markers = buildMarkers(prices, news);

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

  function openPopoverAt(clientX: number, clientY: number, items: NewsItem[]) {
    setPopover({ items, x: clientX, y: clientY });
  }

  return (
    <div ref={wrapperRef} className="h-10 w-32">
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
          {Object.entries(markers).map(([indexStr, items]) => {
            const index = Number(indexStr);
            return (
              <ReferenceDot
                key={index}
                x={index}
                y={data[index].price}
                r={0}
                shape={(dotProps: { cx?: number; cy?: number }) => (
                  <NewsMarker
                    cx={dotProps.cx ?? 0}
                    cy={dotProps.cy ?? 0}
                    onOpen={(clientX, clientY) => openPopoverAt(clientX, clientY, items)}
                  />
                )}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      {popover &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 w-56 rounded-lg border border-neutral-200 bg-white p-2 text-left shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            style={{ left: popover.x, top: popover.y + 12 }}
          >
            <ul className="space-y-2">
              {popover.items.map((item) => (
                <li key={`${item.ticker}-${item.url}`}>
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      {item.ticker}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                      {formatRelativeTime(item.published_at)}
                    </span>
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs font-medium hover:underline"
                  >
                    {item.ai_summary}
                  </a>
                </li>
              ))}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}

// A small filled dot marks where news landed on the chart; a larger
// invisible circle behind it widens the actual click/tap target well
// beyond the visible dot, since the sparkline itself is only 40px tall.
function NewsMarker({
  cx,
  cy,
  onOpen,
}: {
  cx: number;
  cy: number;
  onOpen: (clientX: number, clientY: number) => void;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label="News near this point"
      className="cursor-pointer"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpen(rect.left, rect.top);
        }
      }}
    >
      <circle cx={cx} cy={cy} r={8} fill="transparent" />
      <circle cx={cx} cy={cy} r={3} fill="white" stroke="#6366f1" strokeWidth={1.5} />
    </g>
  );
}
