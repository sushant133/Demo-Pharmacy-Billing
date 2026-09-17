/**
 * What a bill is still owed, and what to call that state.
 *
 * Pure, like lib/fefo.ts and for the same reason: this decides whether a
 * customer owes money, and getting it wrong is the kind of error that is
 * invisible until someone is chased for a bill they already settled.
 *
 * Three facts move the figure, and all three have to be in one place or they
 * disagree:
 *
 *   - what has been received, across the till and any later payments
 *   - what has been handed back, because a returned item is not owed for
 *   - whether the bill was voided, which cancels the debt outright
 */

export const PAYMENT_STATUSES = ["paid", "partial", "unpaid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  paid: "Paid",
  partial: "Partially paid",
  unpaid: "Credit / Unpaid",
};

/** Rupee comparisons are made at paisa precision, never on raw floats. */
const EPSILON = 0.005;

export interface SaleMoney {
  totalAmount: number;
  /** Everything received against this bill, the till payment included. */
  amountReceived: number;
  /** Value of items that have come back. Not owed, and not refunded here. */
  returnedTotal?: number;
  voidedAt?: Date | string | null;
}

export interface SaleSettlement {
  /** What the bill asks for once returns are taken off. */
  totalDue: number;
  paid: number;
  /** Still owed. Never negative - money over the total is change, not debt. */
  remaining: number;
  /** Received above the total. Only actually handed back on a cash sale. */
  change: number;
  status: PaymentStatus;
  /** True once nothing is outstanding. */
  settled: boolean;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Settle one bill.
 *
 * A voided bill is owed nothing whatever was received against it: the sale did
 * not happen, and any money taken is refunded outside this calculation rather
 * than left sitting as a credit balance.
 */
export function settleSale(sale: SaleMoney): SaleSettlement {
  const voided = Boolean(sale.voidedAt);
  const returned = Math.max(0, sale.returnedTotal ?? 0);
  const paid = round2(Math.max(0, sale.amountReceived ?? 0));

  // Returns reduce what is owed, so a bill part-paid and then part-returned
  // can end up settled without another rupee changing hands.
  const totalDue = voided
    ? 0
    : round2(Math.max(0, (sale.totalAmount ?? 0) - returned));

  const balance = round2(totalDue - paid);
  const remaining = balance > EPSILON ? balance : 0;
  const change = balance < -EPSILON ? round2(-balance) : 0;

  return {
    totalDue,
    paid,
    remaining,
    change,
    status: statusFor(totalDue, paid, remaining),
    settled: remaining === 0,
  };
}

function statusFor(totalDue: number, paid: number, remaining: number): PaymentStatus {
  if (remaining === 0) return "paid";
  // Nothing at all has been received: this is a credit sale, not a part payment.
  if (paid <= EPSILON) return "unpaid";
  return "partial";
}

/**
 * Change is money counted back out of the drawer, so it belongs to the methods
 * that have a drawer. A card or a wallet transfer is taken for an exact
 * amount; anything over it is a mistake to correct at the source, not change
 * for the cashier to hand over.
 */
export function givesChange(method: string): boolean {
  return method === "cash";
}
