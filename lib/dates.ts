import { config } from "@/lib/config";

/**
 * Date helpers that respect the pharmacy's local timezone.
 *
 * A VPS usually runs in UTC, so "today's sales" computed with plain
 * `new Date()` would roll over at 05:45 local time in Nepal. Everything here
 * derives day boundaries in BUSINESS_TIMEZONE and returns real UTC instants
 * for querying Mongo.
 */

/** Offset of `tz` from UTC, in minutes, at the given instant. */
function timezoneOffsetMinutes(instant: Date, tz: string): number {
  // Format the instant as if it were in `tz`, then read it back as UTC.
  // The difference is the zone's offset, DST included.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as "24" in some ICU versions.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - instant.getTime()) / 60_000;
}

/** Local calendar date (y/m/d) of an instant, in the business timezone. */
export function localParts(
  instant: Date = new Date(),
  tz: string = config.timezone,
): { year: number; month: number; day: number } {
  const offset = timezoneOffsetMinutes(instant, tz);
  const shifted = new Date(instant.getTime() + offset * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The UTC instant of local midnight starting the day containing `instant`. */
export function startOfLocalDay(
  instant: Date = new Date(),
  tz: string = config.timezone,
): Date {
  const { year, month, day } = localParts(instant, tz);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Resolve the offset at the candidate instant to handle DST edges.
  const guess = new Date(naive);
  const offset = timezoneOffsetMinutes(guess, tz);
  return new Date(naive - offset * 60_000);
}

/** Exclusive end of the local day: local midnight of the following day. */
export function endOfLocalDay(
  instant: Date = new Date(),
  tz: string = config.timezone,
): Date {
  const start = startOfLocalDay(instant, tz);
  return startOfLocalDay(new Date(start.getTime() + 36 * 3_600_000), tz);
}

/** [start, end) covering the local day that contains `instant`. */
export function localDayRange(instant: Date = new Date()): {
  start: Date;
  end: Date;
} {
  return { start: startOfLocalDay(instant), end: endOfLocalDay(instant) };
}

/**
 * Build a [start, end) range from optional `from`/`to` YYYY-MM-DD strings.
 * Both bounds are inclusive of the named local days; `end` is exclusive so it
 * can be used directly with `$lt`.
 */
export function dateRangeFromStrings(
  from?: string,
  to?: string,
): { start?: Date; end?: Date } {
  const range: { start?: Date; end?: Date } = {};

  if (from) {
    const parsed = parseLocalDate(from);
    if (parsed) range.start = startOfLocalDay(parsed);
  }
  if (to) {
    const parsed = parseLocalDate(to);
    if (parsed) range.end = endOfLocalDay(parsed);
  }
  return range;
}

/** Parse a YYYY-MM-DD string as noon local time (safe from offset rollover). */
export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, y, m, d] = match;
  const noonUtc = Date.UTC(Number(y), Number(m) - 1, Number(d), 12);
  return new Date(noonUtc);
}

/** YYYY-MM-DD in the business timezone; the format every date input wants. */
export function toDateInputValue(
  instant: Date = new Date(),
  tz: string = config.timezone,
): string {
  const { year, month, day } = localParts(instant, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * YYYY-MM-DD for a date input, or empty when the value is missing/invalid.
 * Never throws - `toISOString()` on an Invalid Date is a RangeError that
 * becomes an unhandled Server Component crash in production.
 */
export function dateInputValue(
  value: Date | string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return toDateInputValue(date);
}

/** `date` + n days, as a new Date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
