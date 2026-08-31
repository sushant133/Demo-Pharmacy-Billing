/**
 * Purchase costing arithmetic.
 *
 * Pure, like lib/fefo.ts and for the same reason: what a batch costs decides
 * every margin the shop ever reports, so it must be testable without a
 * database. No I/O, no ambient clock, no Mongoose.
 *
 * Two things here are easy to get wrong and expensive to get wrong:
 *
 *   1. **Free scheme units.** Nepali distributors sell "10 + 2 free"
 *      constantly. Twelve units reach the shelf but only ten were paid for, so
 *      the real cost per unit is lower than the invoice line rate. Booking the
 *      invoice rate against all twelve would overstate stock value and
 *      understate margin on every subsequent sale.
 *
 *   2. **Topping up an existing lot.** A repeat delivery of the same batch
 *      number at a different price cannot simply overwrite the old cost; the
 *      units already on the shelf were bought at the old one. The combined
 *      cost is the weighted average.
 */

/** Round to 2 decimals without binary floating point drift. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Round to 4 decimals - unit costs need more precision than money totals. */
export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export class PurchaseMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseMathError";
  }
}

/** One line of a supplier invoice, before any shop-level discount. */
export interface PurchaseLineInput {
  /** Units billed on the invoice. */
  quantity: number;
  /** Bonus units received free with the line. Not billed. */
  freeQuantity?: number;
  /** Rate per billed unit, from the invoice. */
  costPrice: number;
  /** Discount on this line, in rupees, given by the supplier. */
  discount?: number;
}

export interface PurchaseLineTotals {
  /** Units that physically reach the shelf: billed + free. */
  receivedQuantity: number;
  /** quantity * costPrice, before line discount. */
  gross: number;
  discount: number;
  /** What the shop actually pays for this line. */
  net: number;
  /**
   * True cost of one shelf unit: net spend spread over every unit received,
   * free ones included. This is what gets stored on the Batch.
   */
  effectiveUnitCost: number;
}

/**
 * Cost one invoice line.
 *
 * A line that is entirely free (quantity 0, freeQuantity > 0) is legitimate -
 * samples and promotional stock - and lands at zero unit cost.
 */
export function calculateLine(line: PurchaseLineInput): PurchaseLineTotals {
  const quantity = line.quantity;
  const freeQuantity = line.freeQuantity ?? 0;
  const discount = line.discount ?? 0;

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new PurchaseMathError("Billed quantity must be a whole number of units.");
  }
  if (!Number.isInteger(freeQuantity) || freeQuantity < 0) {
    throw new PurchaseMathError("Free quantity must be a whole number of units.");
  }
  if (quantity + freeQuantity <= 0) {
    throw new PurchaseMathError("A purchase line must receive at least one unit.");
  }
  if (line.costPrice < 0) {
    throw new PurchaseMathError("Cost price cannot be negative.");
  }
  if (discount < 0) {
    throw new PurchaseMathError("Line discount cannot be negative.");
  }

  const receivedQuantity = quantity + freeQuantity;
  const gross = round2(quantity * line.costPrice);

  if (discount > gross) {
    throw new PurchaseMathError("Line discount cannot exceed the line value.");
  }

  const net = round2(gross - discount);

  return {
    receivedQuantity,
    gross,
    discount: round2(discount),
    net,
    // Spread net spend across every unit received, free units included.
    effectiveUnitCost: round4(net / receivedQuantity),
  };
}

export interface PurchaseTotalsInput {
  lines: readonly PurchaseLineInput[];
  /** Invoice-level discount in rupees, on top of any line discounts. */
  discount?: number;
  /** e.g. 0.13. Purchases from a VAT-registered supplier carry input VAT. */
  vatRate?: number;
  /** Freight/delivery charged on the invoice. Taxed with the goods. */
  otherCharges?: number;
}

export interface PurchaseTotals {
  lines: PurchaseLineTotals[];
  /** Sum of line net values. */
  subtotal: number;
  discount: number;
  otherCharges: number;
  /** subtotal - discount + otherCharges; the base VAT applies to. */
  taxableAmount: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
  /** Units that will reach the shelf across every line. */
  totalUnits: number;
}

/**
 * Total a supplier invoice.
 *
 * Order matters and mirrors how a Nepali distributor prints the bill:
 * line discounts first, then the invoice-level discount, then freight, then
 * VAT on the resulting taxable amount.
 */
export function calculatePurchaseTotals({
  lines,
  discount = 0,
  vatRate = 0,
  otherCharges = 0,
}: PurchaseTotalsInput): PurchaseTotals {
  if (lines.length === 0) {
    throw new PurchaseMathError("A purchase must have at least one line.");
  }
  if (discount < 0) throw new PurchaseMathError("Discount cannot be negative.");
  if (otherCharges < 0) {
    throw new PurchaseMathError("Other charges cannot be negative.");
  }
  if (vatRate < 0 || vatRate > 1) {
    throw new PurchaseMathError("VAT rate must be a fraction between 0 and 1.");
  }

  const lineTotals = lines.map(calculateLine);
  const subtotal = round2(lineTotals.reduce((sum, line) => sum + line.net, 0));

  if (discount > subtotal) {
    throw new PurchaseMathError("Invoice discount cannot exceed the line total.");
  }

  const taxableAmount = round2(subtotal - discount + otherCharges);
  const vatAmount = round2(taxableAmount * vatRate);

  return {
    lines: lineTotals,
    subtotal,
    discount: round2(discount),
    otherCharges: round2(otherCharges),
    taxableAmount,
    vatRate,
    vatAmount,
    totalAmount: round2(taxableAmount + vatAmount),
    totalUnits: lineTotals.reduce((sum, line) => sum + line.receivedQuantity, 0),
  };
}

/**
 * Blend an existing lot's cost with a fresh delivery of the same batch number.
 *
 * The units already on the shelf were bought at the old price; the new ones at
 * the new price. Overwriting would silently restate the value of stock the
 * shop already owns, so the combined cost is the weighted average.
 *
 * An existing lot that has sold down to zero carries no cost forward, so the
 * new price simply takes over.
 */
export function weightedAverageCost(
  existing: { quantity: number; costPrice: number },
  incoming: { quantity: number; costPrice: number },
): number {
  if (existing.quantity < 0 || incoming.quantity < 0) {
    throw new PurchaseMathError("Quantities cannot be negative.");
  }

  const totalUnits = existing.quantity + incoming.quantity;
  if (totalUnits === 0) return round4(incoming.costPrice);
  if (existing.quantity === 0) return round4(incoming.costPrice);

  const totalValue =
    existing.quantity * existing.costPrice + incoming.quantity * incoming.costPrice;

  return round4(totalValue / totalUnits);
}

/** Margin a batch will earn per unit, given its cost and selling price. */
export function unitMargin(
  costPrice: number,
  salePrice: number,
): { perUnit: number; percent: number } {
  const perUnit = round2(salePrice - costPrice);
  // A zero-cost lot (free samples) has no meaningful margin percentage.
  const percent = costPrice > 0 ? round2((perUnit / costPrice) * 100) : 0;
  return { perUnit, percent };
}

/**
 * Where a supplier invoice stands once payments are applied.
 * Overpayment is treated as fully paid rather than a negative balance; a
 * credit belongs on the supplier ledger, not on one invoice.
 */
export function paymentStatusFor(
  totalAmount: number,
  amountPaid: number,
): "unpaid" | "partial" | "paid" {
  if (amountPaid <= 0) return "unpaid";
  // Tolerate sub-paisa rounding so a fully settled bill never reads "partial".
  if (amountPaid + 0.005 >= totalAmount) return "paid";
  return "partial";
}
