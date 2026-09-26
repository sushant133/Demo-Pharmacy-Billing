/**
 * What may come back over the counter, and why.
 *
 * A pharmacy return is not a generic refund. Medicine that goes back on a
 * shelf will be dispensed to somebody else, so the only thing that may be
 * taken back is stock that is still fit to sell: sealed, undamaged, in its
 * original packaging, and not past its expiry.
 *
 * That splits the rules in two, and the split matters:
 *
 *   - What the *system* can know - is the bill live, is anything left to
 *     return, has that lot expired - is decided here and enforced on the
 *     server. No screen can talk its way past it.
 *   - What only a *person* can know - is the box sealed, is the strip intact,
 *     has it been tampered with - cannot be inferred from any record. It is
 *     a physical check, so the counter attests to it and the attestation is
 *     stored with the return, which is what makes it auditable afterwards.
 *
 * Goods that fail the physical check are not returns at all. They are a
 * write-off against stock, which is a different transaction with a different
 * effect on the books, and the screen says so rather than quietly taking
 * them back onto the shelf.
 */

/** Reasons that leave the goods resalable. */
export const RETURN_REASONS = [
  { code: "changed-mind", label: "Customer changed their mind" },
  { code: "wrong-item", label: "Wrong medicine dispensed" },
  { code: "duplicate", label: "Duplicate or extra quantity" },
  { code: "prescription-changed", label: "Prescription changed by doctor" },
  { code: "billing-error", label: "Billing error" },
  { code: "other", label: "Other (explain below)" },
] as const;

export type ReturnReasonCode = (typeof RETURN_REASONS)[number]["code"];

/**
 * How the money goes back.
 *
 * Recorded because "did we actually hand over cash?" is a question the till
 * has to answer at close, and a return that only says "refunded" leaves the
 * drawer unexplained.
 *
 * `adjust` is the honest third option in this system, and the commonest one on
 * a credit sale: nothing is handed over because the customer had not paid yet,
 * so the return simply reduces what they owe. Offering it on a fully-settled
 * bill would be nonsense, so `refundMethodsFor` decides which are on the table.
 *
 * Store credit is deliberately absent. It is not a way of moving money, it is
 * a liability the shop then owes - it needs a balance that survives the
 * transaction and something at the till that can spend it, and neither
 * exists. Offering it here would print a promise the system cannot keep.
 */
export const REFUND_METHODS = [
  {
    code: "cash",
    label: "Cash from the drawer",
    hint: "Money handed back over the counter.",
  },
  {
    code: "original",
    label: "Back to original payment",
    hint: "Reversed to the card, wallet or bank the bill was paid with.",
  },
  {
    code: "adjust",
    label: "Reduce what they owe",
    hint: "Nothing changes hands; the outstanding balance falls instead.",
  },
] as const;

export type RefundMethodCode = (typeof REFUND_METHODS)[number]["code"];

export const REFUND_METHOD_LABELS: Record<RefundMethodCode, string> =
  Object.fromEntries(
    REFUND_METHODS.map((method) => [method.code, method.label]),
  ) as Record<RefundMethodCode, string>;

export function isRefundMethod(value: unknown): value is RefundMethodCode {
  return (
    typeof value === "string" &&
    REFUND_METHODS.some((method) => method.code === value)
  );
}

/**
 * Which refund methods make sense for this bill.
 *
 * `adjust` only appears where there is something to adjust. A bill paid in
 * full has no balance to reduce, so offering it would let a cashier close a
 * return having handed back nothing and recorded that nothing was owed.
 */
export function refundMethodsFor(
  outstanding: number,
): ReadonlyArray<(typeof REFUND_METHODS)[number]> {
  return REFUND_METHODS.filter(
    (method) => method.code !== "adjust" || outstanding > 0,
  );
}

export interface RefundSplit {
  /** Taken off what the customer still owed on the bill. */
  offBalance: number;
  /** Actually handed back, by the chosen method. */
  paidOut: number;
}

/**
 * How a return's value divides between the customer's debt and money handed
 * back.
 *
 * A customer who still owes on a bill is not paid cash for goods they have not
 * paid for: the return clears the debt first, and only what is left over goes
 * back. It is the same figure `settleSale` arrives at - once returns exceed
 * what is owed, the excess is money received above the total - so the drawer
 * and the ledger agree.
 */
export function refundSplit(returnTotal: number, outstanding: number): RefundSplit {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const total = Math.max(0, returnTotal);
  const offBalance = round(Math.min(total, Math.max(0, outstanding)));
  return { offBalance, paidOut: round(total - offBalance) };
}

/** The method to preselect: reduce a debt where there is one, else cash. */
export function defaultRefundMethod(outstanding: number): RefundMethodCode {
  return outstanding > 0 ? "adjust" : "cash";
}

export const RETURN_REASON_LABELS: Record<ReturnReasonCode, string> =
  Object.fromEntries(
    RETURN_REASONS.map((reason) => [reason.code, reason.label]),
  ) as Record<ReturnReasonCode, string>;

export function isReturnReason(value: unknown): value is ReturnReasonCode {
  return (
    typeof value === "string" &&
    RETURN_REASONS.some((reason) => reason.code === value)
  );
}

/** Why a line cannot be taken back. */
export type IneligibleReason =
  | "sale-voided"
  | "fully-returned"
  | "expired";

export interface EligibilityInput {
  /** Units originally dispensed on this line. */
  quantity: number;
  returnedQuantity?: number | null;
  /** The lot's expiry, as stored on the bill line. */
  expiryDate: Date | string;
  /** A voided bill is not a completed sale and has nothing to give back. */
  saleVoided?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  /** Units that may still come back. 0 whenever `eligible` is false. */
  returnable: number;
  reason: IneligibleReason | null;
  /** Counter-facing explanation. Empty when the line is eligible. */
  message: string;
}

export function remainingUnits(line: {
  quantity: number;
  returnedQuantity?: number | null;
}): number {
  return Math.max(0, line.quantity - (line.returnedQuantity ?? 0));
}

/**
 * An expired lot is never eligible, even for a bill raised yesterday.
 *
 * The question is not "was this sellable when it left?" but "is it sellable
 * now?" - because accepting it puts those units back in front of the next
 * customer. Expired stock that comes back is a write-off, not a return.
 */
export function isExpiredForReturn(
  expiryDate: Date | string,
  asOf: Date = new Date(),
): boolean {
  const expiry =
    expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() < asOf.getTime();
}

export function returnEligibility(
  line: EligibilityInput,
  asOf: Date = new Date(),
): Eligibility {
  const refuse = (reason: IneligibleReason, message: string): Eligibility => ({
    eligible: false,
    returnable: 0,
    reason,
    message,
  });

  if (line.saleVoided) {
    return refuse(
      "sale-voided",
      "This bill was voided, so its stock has already gone back.",
    );
  }

  const remaining = remainingUnits(line);
  if (remaining <= 0) {
    return refuse("fully-returned", "Already returned in full.");
  }

  if (isExpiredForReturn(line.expiryDate, asOf)) {
    return refuse(
      "expired",
      "This lot has expired and cannot go back on the shelf. Write it off instead.",
    );
  }

  return { eligible: true, returnable: remaining, reason: null, message: "" };
}

/**
 * The physical checks the counter confirms before anything is taken back.
 * Listed rather than summarised, because "is it in good condition?" is a
 * question someone answers yes to without looking.
 */
export const CONDITION_CHECKS = [
  "Packaging is original and intact",
  "Seal is unbroken and the strip is not cut",
  "No damage, staining or tampering",
  "Batch and expiry on the pack match the bill",
] as const;
