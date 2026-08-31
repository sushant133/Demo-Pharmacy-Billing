/**
 * Stock alert rules.
 *
 * Pure, like lib/fefo.ts and lib/purchase-math.ts, and for the same reason:
 * these thresholds decide what a pharmacist is told to act on every morning,
 * so they need to be pinned down by tests rather than trusted.
 *
 * Phase 1 shipped two blunt questions - "is stock below N?" and "does this
 * expire within N days?". Both are answered here with the context that makes
 * them actionable:
 *
 *   - Expiry is graded, not binary, because a lot expiring in 20 days needs a
 *     different response from one expiring in 80.
 *   - Low stock is measured in *days of cover* wherever sales history allows,
 *     because 20 boxes of a fast mover is a shortage while 20 boxes of a slow
 *     one is half a year's supply. A flat unit threshold cannot tell them
 *     apart.
 */

export const EXPIRY_SEVERITIES = [
  "expired",
  "critical",
  "warning",
  "watch",
  "ok",
] as const;
export type ExpirySeverity = (typeof EXPIRY_SEVERITIES)[number];

export const STOCK_SEVERITIES = [
  "out",
  "critical",
  "low",
  "ok",
  "overstocked",
] as const;
export type StockSeverity = (typeof STOCK_SEVERITIES)[number];

export class AlertRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertRuleError";
  }
}

/** Day thresholds for expiry grading. Tunable per shop. */
export interface ExpiryThresholds {
  /** At or under this many days: act now. */
  critical: number;
  /** At or under this: plan a return or a discount. */
  warning: number;
  /** At or under this: keep an eye on it. */
  watch: number;
}

export const DEFAULT_EXPIRY_THRESHOLDS: ExpiryThresholds = {
  critical: 30,
  warning: 60,
  watch: 90,
};

/**
 * Grade a batch by how long it has left.
 *
 * Boundaries are inclusive of the harsher band: exactly 30 days out is
 * "critical", not "warning", so a lot never sits in the gentler bucket on the
 * day it crosses the line.
 */
export function expirySeverity(
  daysRemaining: number,
  thresholds: ExpiryThresholds = DEFAULT_EXPIRY_THRESHOLDS,
): ExpirySeverity {
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= thresholds.critical) return "critical";
  if (daysRemaining <= thresholds.warning) return "warning";
  if (daysRemaining <= thresholds.watch) return "watch";
  return "ok";
}

/** Rank for sorting: worst first. */
export function expiryRank(severity: ExpirySeverity): number {
  return EXPIRY_SEVERITIES.indexOf(severity);
}

/**
 * How many days the current shelf stock will last at the recent sales rate.
 *
 * Returns null when there is no sales history to divide by - an honest "not
 * known" rather than a fabricated Infinity, so the caller can fall back to the
 * flat unit threshold and say which rule it used.
 */
export function daysOfCover(
  stockQuantity: number,
  averageDailySales: number,
): number | null {
  if (stockQuantity < 0) {
    throw new AlertRuleError("Stock quantity cannot be negative.");
  }
  if (averageDailySales <= 0) return null;
  return Math.floor((stockQuantity / averageDailySales) * 10) / 10;
}

/** Average units sold per day over a window. */
export function averageDailySales(unitsSold: number, windowDays: number): number {
  if (windowDays <= 0) {
    throw new AlertRuleError("The sales window must be at least one day.");
  }
  if (unitsSold < 0) throw new AlertRuleError("Units sold cannot be negative.");
  return Math.round((unitsSold / windowDays) * 10_000) / 10_000;
}

export interface StockAssessmentInput {
  stockQuantity: number;
  /** Units per day, from recent history. 0 when nothing has sold. */
  averageDailySales: number;
  /** Flat fallback threshold, used when there is no sales history. */
  reorderLevel: number;
  /** Days of stock the shop wants to hold. */
  targetCoverDays?: number;
  /** How long the supplier takes to deliver. */
  leadTimeDays?: number;
}

export interface StockAssessment {
  severity: StockSeverity;
  /** null when there is no sales history to compute it from. */
  daysOfCover: number | null;
  /** Units to order to reach target cover. 0 when nothing is needed. */
  suggestedOrderQuantity: number;
  /** Which rule produced the verdict, so the UI can explain itself. */
  basis: "days-of-cover" | "reorder-level";
}

export const DEFAULT_TARGET_COVER_DAYS = 45;
export const DEFAULT_LEAD_TIME_DAYS = 7;

/**
 * Decide whether a medicine needs reordering, and by how much.
 *
 * Prefers days-of-cover when the medicine has actually been selling, and falls
 * back to the flat reorder level when it has not, since dividing by a zero
 * sales rate says nothing useful.
 *
 * "Overstocked" is deliberately generous (three times target cover): flagging
 * it eagerly on slow movers would drown the genuinely urgent rows, and
 * over-ordering is a cash-flow problem rather than a patient-safety one.
 */
export function assessStock({
  stockQuantity,
  averageDailySales: rate,
  reorderLevel,
  targetCoverDays = DEFAULT_TARGET_COVER_DAYS,
  leadTimeDays = DEFAULT_LEAD_TIME_DAYS,
}: StockAssessmentInput): StockAssessment {
  if (stockQuantity < 0) {
    throw new AlertRuleError("Stock quantity cannot be negative.");
  }
  if (targetCoverDays <= 0) {
    throw new AlertRuleError("Target cover must be at least one day.");
  }

  const cover = daysOfCover(stockQuantity, rate);

  if (stockQuantity === 0) {
    return {
      severity: "out",
      daysOfCover: cover,
      // Nothing on the shelf: order enough to cover the wait plus the target.
      suggestedOrderQuantity:
        rate > 0 ? Math.ceil(rate * (targetCoverDays + leadTimeDays)) : reorderLevel,
      basis: rate > 0 ? "days-of-cover" : "reorder-level",
    };
  }

  if (cover === null) {
    // No sales history - fall back to the flat threshold and say so.
    const severity: StockSeverity =
      stockQuantity < reorderLevel / 2
        ? "critical"
        : stockQuantity < reorderLevel
          ? "low"
          : "ok";

    return {
      severity,
      daysOfCover: null,
      suggestedOrderQuantity:
        severity === "ok" ? 0 : Math.max(0, reorderLevel - stockQuantity),
      basis: "reorder-level",
    };
  }

  const severity: StockSeverity =
    cover <= leadTimeDays
      ? // It runs out before a replacement could plausibly arrive.
        "critical"
      : cover < targetCoverDays
        ? "low"
        : cover > targetCoverDays * 3
          ? "overstocked"
          : "ok";

  const target = Math.ceil(rate * (targetCoverDays + leadTimeDays));

  return {
    severity,
    daysOfCover: cover,
    suggestedOrderQuantity:
      severity === "critical" || severity === "low"
        ? Math.max(0, target - stockQuantity)
        : 0,
    basis: "days-of-cover",
  };
}

export function stockRank(severity: StockSeverity): number {
  return STOCK_SEVERITIES.indexOf(severity);
}

/**
 * Stock that is not moving.
 *
 * A medicine that has never sold is only "dead" once it has had a fair chance,
 * so an item received two days ago is not condemned on day two.
 */
export function isDeadStock({
  daysSinceLastSale,
  daysSinceReceived,
  thresholdDays = 90,
}: {
  daysSinceLastSale: number | null;
  daysSinceReceived: number;
  thresholdDays?: number;
}): boolean {
  if (daysSinceReceived < thresholdDays) return false;
  if (daysSinceLastSale === null) return true;
  return daysSinceLastSale >= thresholdDays;
}

/**
 * Money tied up in stock that will expire before it can plausibly sell.
 *
 * This is the number that justifies acting: not "how much expiring stock do I
 * have" but "how much of it am I actually going to lose".
 */
export function valueAtRisk(
  batches: ReadonlyArray<{
    quantity: number;
    costPrice: number;
    daysRemaining: number;
  }>,
  averageDailySales: number,
): number {
  const total = batches.reduce((sum, batch) => {
    // With no sales rate, assume none of it moves before expiry.
    const sellable =
      averageDailySales > 0
        ? Math.min(
            batch.quantity,
            Math.max(0, averageDailySales * batch.daysRemaining),
          )
        : 0;
    const stranded = Math.max(0, batch.quantity - sellable);
    return sum + stranded * batch.costPrice;
  }, 0);

  return Math.round(total * 100) / 100;
}

/** Tailwind classes per severity, so every screen grades alike. */
export const EXPIRY_TONE: Record<ExpirySeverity, string> = {
  expired: "bg-rose-100 text-rose-700 ring-rose-200",
  critical: "bg-orange-100 text-orange-700 ring-orange-200",
  warning: "bg-amber-100 text-amber-800 ring-amber-200",
  watch: "bg-slate-100 text-slate-700 ring-slate-200",
  ok: "bg-emerald-100 text-emerald-700 ring-emerald-200",
};

export const STOCK_TONE: Record<StockSeverity, string> = {
  out: "bg-rose-100 text-rose-700 ring-rose-200",
  critical: "bg-orange-100 text-orange-700 ring-orange-200",
  low: "bg-amber-100 text-amber-800 ring-amber-200",
  ok: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  overstocked: "bg-violet-100 text-violet-700 ring-violet-200",
};

export const EXPIRY_LABEL: Record<ExpirySeverity, string> = {
  expired: "Expired",
  critical: "Within a month",
  warning: "Within two months",
  watch: "Within three months",
  ok: "In date",
};

export const STOCK_LABEL: Record<StockSeverity, string> = {
  out: "Out of stock",
  critical: "Runs out before restock",
  low: "Below target cover",
  ok: "Healthy",
  overstocked: "Overstocked",
};
