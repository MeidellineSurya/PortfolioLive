import type { Currency } from "./types";

// One formatter per currency, not a single one reconfigured per call —
// Intl.NumberFormat instances are relatively expensive to construct, so
// each is built once and reused. IDR conventionally displays with 0
// fraction digits (Rupiah isn't subdivided in everyday use), unlike USD.
const currencyFormatters: Record<Currency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }),
  IDR: new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }),
};

// Defaults to USD so every pre-existing call site (written before IDR
// support existed) keeps formatting exactly as before without being
// touched — only call sites that actually have a row's currency need to
// pass it explicitly.
export function formatCurrency(value: number, currency: Currency = "USD"): string {
  return currencyFormatters[currency].format(value);
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatSignedCurrency(value: number, currency: Currency = "USD"): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCurrency(value, currency)}`;
}

export function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
