import { round2 } from "@/lib/fefo";

/**
 * Goods going back to the supplier: how many units may still go, and what
 * that slice of the invoice was worth.
 *
 * The mirror of lib/sale-return.ts, and deliberately so - a return is a dated
 * correction on top of a document that is never rewritten, at both ends of the
 * shop. The posted GRN still says what arrived; what went back is appended
 * beside it, and the supplier balance subtracts the running total.
 *
 * Two limits apply to every line, and the second is the one that makes this
 * different from a customer return:
 *
 *   1. You cannot send back more than arrived, less whatever already went
 *      back. That is the invoice talking.
 *   2. You cannot send back more than is *still on the shelf in that lot*.
 *      Units that have been dispensed are with a patient; the fact that the
 *      supplier shipped them short-dated does not put them back in the box.
 *      A shop that has sold 80 of 100 can return 20, and no screen may talk
 *      its way past that.
 *
 * Pure, like the FEFO and sale-return planners, so the arithmetic that decides
 * what a shop is owed is testable without a database.
 */

/** Why the goods are going back. Each leaves the shop owed money. */
export const PURCHASE_RETURN_REASONS = [
  { code: "damaged", label: "Damaged or broken in transit" },
  { code: "expired", label: "Expired or too short-dated" },
  { code: "wrong-item", label: "Wrong medicine supplied" },
  { code: "over-supplied", label: "More sent than ordered" },
  { code: "not-ordered", label: "Not ordered" },
  { code: "recalled", label: "Recalled by the manufacturer" },
  { code: "other", label: "Other (explain below)" },
] as const;

export type PurchaseReturnReasonCode =
  (typeof PURCHASE_RETURN_REASONS)[number]["code"];

export const PURCHASE_RETURN_REASON_LABELS: Record<
  PurchaseReturnReasonCode,
  string
> = Object.fromEntries(
  PURCHASE_RETURN_REASONS.map((reason) => [reason.code, reason.label]),
) as Record<PurchaseReturnReasonCode, string>;

export function isPurchaseReturnReason(
  value: unknown,
): value is PurchaseReturnReasonCode {
  return (
    typeof value === "string" &&
    PURCHASE_RETURN_REASONS.some((reason) => reason.code === value)
  );
}

/** Raised when a requested return cannot be honoured. Carries a usable message. */
export class PurchaseReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseReturnError";
  }
}

/** Why a line cannot go back. */
export type PurchaseIneligibleReason =
  | "not-posted"
  | "cancelled"
  | "fully-returned"
  | "no-stock-left";

export const PURCHASE_INELIGIBLE_LABELS: Record<
  PurchaseIneligibleReason,
  string
> = {
  "not-posted": "This GRN has not been posted, so no stock exists to send back.",
  cancelled: "This GRN was cancelled. Its stock was already reversed.",
  "fully-returned": "Every unit on this line has already gone back.",
  "no-stock-left":
    "None of this lot is left on the shelf - the units were dispensed.",
};

export interface PurchaseLineForReturn {
  /** Units received: billed plus free. This is what may go back. */
  receivedQuantity: number;
  returnedQuantity?: number | null;
  /** What is physically left in the lot right now. */
  onHandQuantity: number;
  /** Net cost per shelf unit, which is what a returned unit is worth. */
  effectiveUnitCost: number;
  medicineId: string;
  medicineName: string;
  batchId: string | null;
  batchNumber: string;
}

export interface PurchaseReturnEligibility {
  eligible: boolean;
  /** The most units this line can send back right now. */
  returnable: number;
  reason: PurchaseIneligibleReason | null;
}

/**
 * How much of one line may go back.
 *
 * `onHandQuantity` is checked even when the invoice says units remain: the
 * binding limit is whichever is smaller, and saying "3 returnable" for a lot
 * with 1 on the shelf would only produce a refusal one screen later.
 */
export function purchaseLineEligibility(
  line: PurchaseLineForReturn,
  status: string,
): PurchaseReturnEligibility {
  if (status === "cancelled") {
    return { eligible: false, returnable: 0, reason: "cancelled" };
  }
  if (status !== "posted") {
    return { eligible: false, returnable: 0, reason: "not-posted" };
  }

  const alreadyBack = Math.max(0, line.returnedQuantity ?? 0);
  const leftOnInvoice = Math.max(0, line.receivedQuantity - alreadyBack);

  if (leftOnInvoice === 0) {
    return { eligible: false, returnable: 0, reason: "fully-returned" };
  }

  const onHand = Math.max(0, line.onHandQuantity);
  if (onHand === 0) {
    return { eligible: false, returnable: 0, reason: "no-stock-left" };
  }

  return {
    eligible: true,
    returnable: Math.min(leftOnInvoice, onHand),
    reason: null,
  };
}

export interface PurchaseReturnRequest {
  lineIndex: number;
  quantity: number;
}

export interface PlannedPurchaseReturnLine {
  lineIndex: number;
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitCost: number;
  /** quantity * unitCost. What the shop is owed for this line. */
  lineTotal: number;
}

export interface PlannedPurchaseReturn {
  items: PlannedPurchaseReturnLine[];
  units: number;
  /** Total credit this return is worth. */
  totalAmount: number;
}

export interface PurchaseForReturn {
  status: string;
  items: ReadonlyArray<PurchaseLineForReturn>;
}

/**
 * Turn a set of requested quantities into a costed plan, or refuse.
 *
 * Every refusal names the medicine, because "quantity too high" on a ten-line
 * delivery tells whoever is holding the box nothing they can act on.
 */
export function planPurchaseReturn(
  purchase: PurchaseForReturn,
  requests: readonly PurchaseReturnRequest[],
): PlannedPurchaseReturn {
  const wanted = requests.filter((request) => request.quantity > 0);
  if (wanted.length === 0) {
    throw new PurchaseReturnError("Enter how many units are going back.");
  }

  // Two rows for the same line would each pass the per-line check and together
  // exceed it, so they are folded before anything is validated.
  const merged = new Map<number, number>();
  for (const request of wanted) {
    if (!Number.isInteger(request.quantity)) {
      throw new PurchaseReturnError("Return quantities must be whole units.");
    }
    merged.set(
      request.lineIndex,
      (merged.get(request.lineIndex) ?? 0) + request.quantity,
    );
  }

  const items: PlannedPurchaseReturnLine[] = [];
  let units = 0;
  let totalAmount = 0;

  for (const [lineIndex, quantity] of merged) {
    const line = purchase.items[lineIndex];
    if (!line) {
      throw new PurchaseReturnError("That line is not on this delivery.");
    }

    const eligibility = purchaseLineEligibility(line, purchase.status);
    if (!eligibility.eligible) {
      throw new PurchaseReturnError(
        `${line.medicineName}: ${
          PURCHASE_INELIGIBLE_LABELS[eligibility.reason ?? "not-posted"]
        }`,
      );
    }

    if (quantity > eligibility.returnable) {
      throw new PurchaseReturnError(
        `${line.medicineName}: only ${eligibility.returnable} unit(s) can go back.`,
      );
    }

    if (!line.batchId) {
      throw new PurchaseReturnError(
        `${line.medicineName}: this line has no lot on the shelf to draw from.`,
      );
    }

    const lineTotal = round2(quantity * line.effectiveUnitCost);

    items.push({
      lineIndex,
      medicineId: line.medicineId,
      medicineName: line.medicineName,
      batchId: line.batchId,
      batchNumber: line.batchNumber,
      quantity,
      unitCost: line.effectiveUnitCost,
      lineTotal,
    });

    units += quantity;
    totalAmount = round2(totalAmount + lineTotal);
  }

  // Stable order, so a credit note lists lines as the GRN does.
  items.sort((a, b) => a.lineIndex - b.lineIndex);

  return { items, units, totalAmount: round2(totalAmount) };
}
