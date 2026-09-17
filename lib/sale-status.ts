import { settleSale, type SaleMoney } from "@/lib/sale-payment";

/**
 * One word for the state a bill is in.
 *
 * A sale carries three independent facts - was it voided, has anything come
 * back, and has it been paid for - and a list that shows all three at once is
 * a list nobody scans. This collapses them into the single answer a person
 * actually wants, with a deliberate order of precedence:
 *
 *   1. Cancelled  - a voided bill. Nothing else about it matters any more.
 *   2. Refunded   - goods came back. Whether the money was ever collected is
 *                   a detail behind a settled reversal.
 *   3. Pending    - money is still owed on a live bill.
 *   4. Paid       - nothing owed, nothing returned.
 *
 * Pure and tested, because "has this customer paid?" is not a question to get
 * wrong, and because the same rule has to drive both the badge and the filter
 * that claims to find those badges.
 */

export const SALE_STATUSES = [
  "paid",
  "pending",
  "refunded",
  "cancelled",
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export type BadgeTone = "slate" | "brand" | "green" | "amber" | "rose";

export interface SaleStatusView {
  status: SaleStatus;
  /** What the badge reads. More specific than the status where it helps. */
  label: string;
  tone: BadgeTone;
  /** Money still owed on a live bill. 0 for everything else. */
  remaining: number;
}

export interface SaleStatusInput extends SaleMoney {
  /** Units that have come back. */
  returnedUnits?: number;
  /** Units originally sold, to tell a full refund from a partial one. */
  soldUnits?: number;
}

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  paid: "Paid",
  pending: "Pending",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export function saleStatus(sale: SaleStatusInput): SaleStatusView {
  if (sale.voidedAt) {
    return { status: "cancelled", label: "Cancelled", tone: "rose", remaining: 0 };
  }

  const returnedUnits = sale.returnedUnits ?? 0;
  if (returnedUnits > 0) {
    // A bill where everything came back reads differently from one where a
    // single strip did, and the counter needs to tell them apart at a glance.
    const full = sale.soldUnits != null && returnedUnits >= sale.soldUnits;
    return {
      status: "refunded",
      label: full ? "Refunded" : "Part refunded",
      tone: "amber",
      remaining: 0,
    };
  }

  const settlement = settleSale(sale);
  if (settlement.remaining > 0) {
    return {
      status: "pending",
      // "Pending" is the filter; the badge says which kind, because chasing a
      // bill nothing was paid on is a different conversation from chasing the
      // balance of one that was part-paid.
      label: settlement.status === "unpaid" ? "Unpaid" : "Part paid",
      tone: settlement.status === "unpaid" ? "rose" : "amber",
      remaining: settlement.remaining,
    };
  }

  return { status: "paid", label: "Paid", tone: "green", remaining: 0 };
}

/**
 * The same rule as a Mongo filter, so the dropdown finds exactly the rows the
 * badges show. Kept beside `saleStatus` precisely so the two cannot drift.
 *
 * `paymentStatus` is absent on bills written before the payment ledger
 * existed; those were all paid in full, which is why "paid" accepts a missing
 * field and "pending" requires an explicit one.
 */
export function saleStatusFilter(status: SaleStatus): Record<string, unknown> {
  const noReturns = { returnedUnits: { $not: { $gt: 0 } } };

  switch (status) {
    case "cancelled":
      return { voidedAt: { $ne: null } };
    case "refunded":
      return { voidedAt: null, returnedUnits: { $gt: 0 } };
    case "pending":
      return {
        voidedAt: null,
        ...noReturns,
        paymentStatus: { $in: ["partial", "unpaid"] },
      };
    case "paid":
      return {
        voidedAt: null,
        ...noReturns,
        $or: [{ paymentStatus: "paid" }, { paymentStatus: { $exists: false } }],
      };
  }
}

/** The shape a lean Sale document presents to a list. */
export interface SaleRecord {
  totalAmount: number;
  amountReceived?: number | null;
  returnedTotal?: number | null;
  returnedUnits?: number | null;
  voidedAt?: Date | string | null;
  /** Absent on bills written before the payment ledger existed. */
  paymentStatus?: string | null;
  items?: ReadonlyArray<{ quantity: number }>;
}

/**
 * Status for a stored bill, handling the one case the pure rule cannot see.
 *
 * A bill with no `paymentStatus` predates the payment ledger. Back then a
 * completed sale was a paid sale, and `amountReceived` was either absent or a
 * meaningless 0 - the field existed briefly before anything populated it. So
 * a missing status is read as paid in full, and the stored zero is ignored
 * rather than believed.
 *
 * Reading it any other way turns the shop's entire history into debt. This is
 * the same rule `saleStatusFilter` applies on the database side, and both live
 * here so the badge and the dropdown cannot come to different answers.
 * `npm run backfill:payments` removes the ambiguity for good.
 */
export function saleStatusFor(sale: SaleRecord): SaleStatusView {
  const legacy = sale.paymentStatus == null;

  return saleStatus({
    totalAmount: sale.totalAmount,
    amountReceived: legacy ? sale.totalAmount : (sale.amountReceived ?? 0),
    returnedTotal: sale.returnedTotal ?? 0,
    voidedAt: sale.voidedAt,
    returnedUnits: sale.returnedUnits ?? 0,
    soldUnits: sale.items?.reduce((sum, item) => sum + item.quantity, 0),
  });
}

export function isSaleStatus(value: unknown): value is SaleStatus {
  return (
    typeof value === "string" && (SALE_STATUSES as readonly string[]).includes(value)
  );
}
