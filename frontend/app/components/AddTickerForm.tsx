"use client";

import { useState, type FormEvent } from "react";
import type { Holding } from "@/lib/types";

// Mirrors backend/models.py's TICKER_RE — catching an obviously invalid
// ticker here means the user sees why immediately, instead of waiting on
// a round trip to the backend just to get the same rejection back.
const TICKER_RE = /^[A-Z]{1,5}$/;

type AddTickerFormProps = {
  onAdd: (holding: Holding) => void;
};

export default function AddTickerForm({ onAdd }: AddTickerFormProps) {
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("");
  const [avgCost, setAvgCost] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const normalizedTicker = ticker.trim().toUpperCase();
    const parsedQuantity = Number(quantity);
    const parsedAvgCost = Number(avgCost);

    if (!TICKER_RE.test(normalizedTicker)) {
      setError("Ticker must be 1-5 letters (e.g. AAPL).");
      return;
    }
    if (!(parsedQuantity > 0) || !(parsedAvgCost > 0)) {
      setError("Quantity and avg cost must be positive numbers.");
      return;
    }

    setError(null);
    onAdd({ ticker: normalizedTicker, quantity: parsedQuantity, avg_cost: parsedAvgCost });
    setTicker("");
    setQuantity("");
    setAvgCost("");
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="add-ticker" className="text-xs text-neutral-500 dark:text-neutral-400">
          Ticker
        </label>
        <input
          id="add-ticker"
          value={ticker}
          onChange={(event) => setTicker(event.target.value.toUpperCase())}
          placeholder="AAPL"
          maxLength={5}
          className="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm uppercase dark:border-neutral-700"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="add-quantity" className="text-xs text-neutral-500 dark:text-neutral-400">
          Qty
        </label>
        <input
          id="add-quantity"
          type="number"
          min="0"
          step="any"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          placeholder="10"
          className="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="add-avg-cost" className="text-xs text-neutral-500 dark:text-neutral-400">
          Avg Cost
        </label>
        <input
          id="add-avg-cost"
          type="number"
          min="0"
          step="any"
          value={avgCost}
          onChange={(event) => setAvgCost(event.target.value)}
          placeholder="180.00"
          className="w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
        />
      </div>
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        Add
      </button>
      {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
