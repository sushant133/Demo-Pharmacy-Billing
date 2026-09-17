import { config } from "@/lib/config";

/**
 * One word for the state a medicine's shelf position is in.
 *
 * A stock line carries three independent facts - is any of it still sellable,
 * is there enough of it, and is it about to turn - and a table showing all
 * three at once is a table nobody scans. This collapses them into the single
 * answer somebody actually wants, in the order of what has to be done:
 *
 *   1. Expired  - none of it can be sold. Pull it off the shelf today.
 *   2. Low      - not enough to serve customers. Reorder it.
 *   3. Expiring - still sellable, but on a clock. Move it or send it back.
 *   4. In stock - nothing to do.
 *
 * Pure and tested, for the same reason `saleStatus` is: the badge and the
 * dropdown that claims to find those badges are drawn from one rule, so they
 * cannot come to different answers. `asOf` is passed in rather than read from
 * the clock so the boundaries are actually testable - the same choice
 * `isExpired` makes in lib/fefo.ts.
 */

export const STOCK_STATUSES = ["ok", "low", "expiring", "expired"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** The statuses plus the "no filter" option the dropdown needs. */
export const STOCK_FILTERS = ["all", ...STOCK_STATUSES] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

export type StockTone = "green" | "amber" | "rose" | "slate";

export interface StockLevel {
  /** Units held that have not expired. What can actually be sold. */
  sellable: number;
  /** Units held that have expired. Physically present, worth nothing. */
  expiredUnits: number;
  /** The medicine's own reorder level. Null means the shop default applies. */
  reorderLevel: number | null;
  /** Earliest expiry among lots that have not expired. Null when none have. */
  nearestExpiry: Date | string | null;
}

export interface StockStatusView {
  status: StockStatus;
  label: string;
  tone: StockTone;
}

export const STOCK_FILTER_LABELS: Record<StockFilter, string> = {
  all: "All stock",
  ok: "In stock",
  low: "At or below reorder",
  expiring: `Expiring within ${config.expiryAlertDays} days`,
  expired: "Has expired stock",
};

/**
 * At or under the reorder level the pharmacy set for this medicine.
 *
 * Counted on sellable units only. Counting expired boxes towards the reorder
 * level is how a shop ends up not reordering something it cannot sell.
 */
export function isLowStock(row: StockLevel): boolean {
  return row.reorderLevel != null && row.sellable <= row.reorderLevel;
}

/** Whole days until the earliest sellable lot turns. Null when none is. */
export function daysToExpiry(
  row: StockLevel,
  asOf: Date = new Date(),
): number | null {
  if (!row.nearestExpiry) return null;
  const expiry = new Date(row.nearestExpiry).getTime();
  if (Number.isNaN(expiry)) return null;
  return Math.floor((expiry - asOf.getTime()) / 86_400_000);
}

export function stockStatus(
  row: StockLevel,
  asOf: Date = new Date(),
): StockStatusView {
  // Nothing sellable left. Whether it is also below its reorder level is a
  // detail behind a line that cannot be dispensed at all.
  if (row.sellable <= 0) {
    return { status: "expired", label: "Expired", tone: "rose" };
  }

  if (isLowStock(row)) {
    return { status: "low", label: "Low stock", tone: "amber" };
  }

  const days = daysToExpiry(row, asOf);
  if (days != null && days <= config.expiryAlertDays) {
    return { status: "expiring", label: "Expiring", tone: "amber" };
  }

  return { status: "ok", label: "In stock", tone: "green" };
}

/**
 * Whether a row belongs under the chosen filter.
 *
 * Every filter matches the badge exactly, with one deliberate exception:
 * "expired" asks whether the line has *any* dead stock on it, not whether dead
 * stock is its headline state. A well-stocked line with two turned boxes in it
 * reads "In stock" - correctly, because it can still be dispensed - and is
 * still the thing somebody hunting for stock to write off needs to find.
 */
export function matchesStockFilter(
  row: StockLevel,
  filter: StockFilter,
  asOf: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  if (filter === "expired") return row.expiredUnits > 0;
  return stockStatus(row, asOf).status === filter;
}

export function isStockFilter(value: unknown): value is StockFilter {
  return (
    typeof value === "string" && (STOCK_FILTERS as readonly string[]).includes(value)
  );
}
