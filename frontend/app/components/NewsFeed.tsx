"use client";

import type { NewsItem } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

type NewsFeedProps = {
  items: NewsItem[];
};

export default function NewsFeed({ items }: NewsFeedProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No news yet — items appear here as they come in for your holdings.
      </p>
    );
  }

  return (
    <ul className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
      {items.map((item) => (
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
  );
}
