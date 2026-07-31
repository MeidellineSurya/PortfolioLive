"use client";

import { useEffect, useState } from "react";
import { isMarketOpen } from "@/lib/marketHours";
import type { Currency } from "@/lib/types";

// Recomputed on a timer rather than only at mount — a tab left open
// across a market open/close boundary would otherwise show a stale
// status until something else (a price tick) happened to force a
// re-render, which doesn't happen at all while the market is closed.
const REFRESH_INTERVAL_MS = 60_000;

export default function MarketStatusBadge({ currency }: { currency: Currency }) {
  const [open, setOpen] = useState(() => isMarketOpen(currency));

  useEffect(() => {
    setOpen(isMarketOpen(currency));
    const id = setInterval(() => setOpen(isMarketOpen(currency)), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [currency]);

  const label = open ? "Market open" : "Market closed";
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        open ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
      }`}
    />
  );
}
