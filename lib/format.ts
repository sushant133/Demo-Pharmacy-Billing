import { config } from "@/lib/config";

/**
 * Display formatting. Shared by server and client components, so it must stay
 * free of Node-only imports.
 */

const npr = new Intl.NumberFormat("en-NP", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Rs 1,234.50 - the notation Nepali pharmacy bills actually use. */
export function money(value: number | null | undefined): string {
  return "Rs " + npr.format(Number(value ?? 0));
}

/** Amount without the currency prefix, for tables that label the column. */
export function amount(value: number | null | undefined): string {
  return npr.format(Number(value ?? 0));
}

export function integer(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-NP").format(Number(value ?? 0));
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 12 Aug 2026 */
export function formatDate(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: config.timezone,
  }).format(date);
}

/** 12 Aug 2026, 14:05 */
export function formatDateTime(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone,
  }).format(date);
}

/** 14:05 - enough for a same-day sales list. */
export function formatTime(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone,
  }).format(date);
}

/** Aug 2026 - how expiry is printed on the pack. */
export function formatExpiry(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: config.timezone,
  }).format(date);
}

/** "in 12 days" / "expired 3 days ago" / "expires today" */
export function describeExpiry(days: number): string {
  if (days < 0) {
    const ago = Math.abs(days);
    return `expired ${ago} day${ago === 1 ? "" : "s"} ago`;
  }
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `in ${days} days`;
}

/** Tailwind classes for an expiry urgency badge. */
export function expiryTone(days: number): string {
  if (days < 0) return "bg-rose-100 text-rose-700 ring-rose-200";
  if (days <= 30) return "bg-orange-100 text-orange-700 ring-orange-200";
  if (days <= 90) return "bg-amber-100 text-amber-700 ring-amber-200";
  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
}

/** Initials for the avatar chip in the top bar. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
