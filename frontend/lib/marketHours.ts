// Fixed regular-session schedules, not a live exchange calendar — there's
// no holiday feed wired up for either market, so a market holiday will
// show as "open" here when it's actually closed. Good enough for "is this
// number fresh right now" at a glance; not meant to be authoritative.
import type { Currency } from "./types";

type Window = { start: number; end: number }; // minutes since midnight, exchange-local time

const NYSE_TIMEZONE = "America/New_York";
const IDX_TIMEZONE = "Asia/Jakarta";

const NYSE_HOURS: Window[] = [{ start: 9 * 60 + 30, end: 16 * 60 }];

// IDX trades in two sessions with a midday break; Friday's break runs
// longer (around Friday prayers) than the rest of the week.
const IDX_HOURS_MON_THU: Window[] = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 13 * 60 + 30, end: 15 * 60 + 50 },
];
const IDX_HOURS_FRI: Window[] = [
  { start: 9 * 60, end: 11 * 60 + 30 },
  { start: 14 * 60, end: 15 * 60 + 50 },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const weekdayName = parts.find((p) => p.type === "weekday")!.value;
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return { weekday: WEEKDAYS.indexOf(weekdayName), minutes: hour * 60 + minute };
}

function withinAnyWindow(minutes: number, windows: Window[]): boolean {
  return windows.some((w) => minutes >= w.start && minutes < w.end);
}

export function isMarketOpen(currency: Currency, now: Date = new Date()): boolean {
  if (currency === "IDR") {
    const { weekday, minutes } = localParts(now, IDX_TIMEZONE);
    if (weekday === 0 || weekday === 6) return false;
    return withinAnyWindow(minutes, weekday === 5 ? IDX_HOURS_FRI : IDX_HOURS_MON_THU);
  }
  const { weekday, minutes } = localParts(now, NYSE_TIMEZONE);
  if (weekday === 0 || weekday === 6) return false;
  return withinAnyWindow(minutes, NYSE_HOURS);
}
