"use client";

import { useState, type ReactNode } from "react";
import type { NewsItem } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const LOAD_MORE_LIMIT = 5;

type NewsFeedProps = {
  items: NewsItem[];
  tickers: string[];
};

export default function NewsFeed({ items, tickers }: NewsFeedProps) {
  // `null` means "All" — not the string "ALL", which would collide with
  // a real ticker (Allstate Corporation trades as ALL).
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  // Keyed by ticker: extra older items fetched via "Load more", layered
  // on top of whatever's arrived live over the WebSocket. Kept separate
  // from the `items` prop (which page.tsx owns and feeds from the socket)
  // rather than merged upstream — this is state that only this component
  // cares about, and page.tsx's `news` state is meant to represent "what
  // arrived live," not "everything ever fetched."
  const [loadedMore, setLoadedMore] = useState<Record<string, NewsItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = selectedTicker
    ? [...items.filter((item) => item.ticker === selectedTicker), ...(loadedMore[selectedTicker] ?? [])]
    : items;

  // A load-more page can overlap with a live item that arrived in
  // between (both sides guard against re-sending the same article, but
  // belt-and-suspenders here costs nothing and avoids a visible dupe if
  // that guard ever has a gap).
  const seen = new Set<string>();
  const visible = filtered.filter((item) => {
    const key = `${item.ticker}-${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  async function handleLoadMore() {
    if (!selectedTicker) return;
    setLoading(true);
    setError(null);
    try {
      const oldest = visible[visible.length - 1];
      const params = new URLSearchParams({ limit: String(LOAD_MORE_LIMIT) });
      if (oldest) params.set("before", oldest.published_at);

      const res = await fetch(`${API_URL}/news/${selectedTicker}?${params.toString()}`);
      if (!res.ok) throw new Error(`request failed: ${res.status}`);

      const more: NewsItem[] = await res.json();
      if (more.length === 0) {
        setError("No older news found for this ticker.");
      } else {
        setLoadedMore((prev) => ({ ...prev, [selectedTicker]: [...(prev[selectedTicker] ?? []), ...more] }));
      }
    } catch {
      setError("Couldn't load more news — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1">
        <TabButton active={selectedTicker === null} onClick={() => setSelectedTicker(null)}>
          All
        </TabButton>
        {tickers.map((ticker) => (
          <TabButton key={ticker} active={selectedTicker === ticker} onClick={() => setSelectedTicker(ticker)}>
            {ticker}
          </TabButton>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No news yet — items appear here as they come in for your holdings.
        </p>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <ul className="space-y-3">
            {visible.map((item) => (
              <li
                key={`${item.ticker}-${item.url}`}
                className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {item.ticker}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                    {formatRelativeTime(item.published_at)}
                  </span>
                </div>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm font-medium hover:underline"
                >
                  {item.ai_summary}
                </a>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{item.headline}</p>
              </li>
            ))}
          </ul>

          {selectedTicker && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loading}
              className="mt-3 w-full rounded border border-neutral-300 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
          {error && <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs font-medium ${
        active
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}
