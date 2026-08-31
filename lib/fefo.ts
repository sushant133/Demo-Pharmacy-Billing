/**
 * FEFO (First-Expiry-First-Out) batch selection.
 *
 * This module is deliberately pure: no database, no Mongoose, no dates pulled
 * from the ambient clock. Everything it needs is passed in, which makes the
 * most business-critical logic in the system directly unit-testable.
 *
 * Rules, in order:
 *   1. A batch that has already expired is never dispensed.
 *   2. A batch with no sellable quantity is skipped.
 *   3. Remaining batches are consumed earliest-expiry-first, so stock that
 *      would otherwise be written off leaves the shelf first.
 *   4. Ties on expiry are broken by the older batch (earlier createdAt), then
 *      by batch id, so allocation is deterministic and reproducible.
 *   5. A line is only allocated if it can be filled completely; a partial
 *      fill is reported as a shortfall and the caller rejects the sale.
 */

/** Minimal batch shape the allocator needs. Ids stay opaque strings. */
export interface AllocatableBatch {
  batchId: string;
  medicineId: string;
  batchNumber: string;
  /** Units currently on the shelf for this batch. */
  quantity: number;
  /** Price per unit charged to the customer. */
  salePrice: number;
  /**
   * What the shop paid per unit for this lot. Optional, and deliberately not
   * used by the allocator: FEFO decides on expiry alone. Cost merely rides
   * along so the caller can record COGS against the sale.
   */
  costPrice?: number;
  expiryDate: Date;
  createdAt?: Date;
}

/** One requested line from the cart. */
export interface AllocationRequest {
  medicineId: string;
  quantity: number;
}

/** A single batch draw that makes up (part of) a requested line. */
export interface AllocationPick {
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitPrice: number;
  /** Cost per unit at the moment of allocation, for COGS. */
  unitCost: number;
  expiryDate: Date;
  /** quantity * unitPrice, rounded to 2 decimals. */
  subtotal: number;
  /** quantity * unitCost, rounded to 2 decimals. */
  lineCost: number;
}

/** The full allocation for one requested medicine line. */
export interface AllocatedLine {
  medicineId: string;
  requestedQuantity: number;
  picks: AllocationPick[];
  /** Sum of pick subtotals for this line, rounded to 2 decimals. */
  lineTotal: number;
  /** Sum of pick costs for this line, rounded to 2 decimals. */
  lineCost: number;
}

/** Why a line could not be filled. */
export interface AllocationShortfall {
  medicineId: string;
  requested: number;
  /** Units that were actually available (non-expired, in stock). */
  available: number;
  shortBy: number;
  /** Units that exist but were excluded because the batch has expired. */
  expiredUnitsIgnored: number;
  reason: "out-of-stock" | "insufficient-stock" | "all-stock-expired";
}

export type FefoResult =
  | { ok: true; lines: AllocatedLine[] }
  | { ok: false; shortfalls: AllocationShortfall[] };

export class FefoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FefoError";
  }
}

/** Round to 2 decimals without float drift (0.1 + 0.2 style errors). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * A batch is expired once its expiry date has passed.
 *
 * Pharmacy convention: medicine printed "EXP 03/2027" is usable through the
 * last day of that month, so callers store expiryDate as the final usable
 * instant. A batch expiring exactly at `asOf` is still sellable.
 */
export function isExpired(batch: { expiryDate: Date }, asOf: Date): boolean {
  return batch.expiryDate.getTime() < asOf.getTime();
}

/**
 * Deterministic FEFO ordering: earliest expiry, then oldest batch, then id.
 * Exported so callers (and tests) can preview the dispensing order.
 */
export function compareFefo(a: AllocatableBatch, b: AllocatableBatch): number {
  const byExpiry = a.expiryDate.getTime() - b.expiryDate.getTime();
  if (byExpiry !== 0) return byExpiry;

  const aCreated = a.createdAt?.getTime() ?? 0;
  const bCreated = b.createdAt?.getTime() ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;

  return a.batchId.localeCompare(b.batchId);
}

/** Sellable = not expired and has quantity on the shelf, in FEFO order. */
export function sellableBatches(
  batches: readonly AllocatableBatch[],
  asOf: Date,
): AllocatableBatch[] {
  return batches
    .filter((batch) => batch.quantity > 0 && !isExpired(batch, asOf))
    .sort(compareFefo);
}

/**
 * Allocate every requested line against the supplied batch pool.
 *
 * The pool is consumed across lines, so requesting the same medicine twice
 * cannot double-spend one batch. Returns every shortfall at once rather than
 * failing on the first, so the cashier can fix the whole cart in one pass.
 *
 * @param requests Cart lines. Duplicate medicineIds are merged.
 * @param batches  Candidate batches (typically every batch for the requested
 *                 medicines). The caller's objects are not mutated.
 * @param asOf     The instant the sale happens. Injected for testability.
 */
export function allocateFefo(
  requests: readonly AllocationRequest[],
  batches: readonly AllocatableBatch[],
  asOf: Date = new Date(),
): FefoResult {
  const merged = mergeRequests(requests);

  // Work on copies so the caller's batch objects keep their real quantities.
  const working = batches.map((batch) => ({ ...batch }));

  // Group sellable stock by medicine, each group pre-sorted into FEFO order.
  const pool = new Map<string, AllocatableBatch[]>();
  for (const batch of sellableBatches(working, asOf)) {
    const group = pool.get(batch.medicineId);
    if (group) group.push(batch);
    else pool.set(batch.medicineId, [batch]);
  }

  // Expired stock is tracked only so the error message can explain *why*
  // stock that appears on the shelf is not sellable.
  const expiredUnits = new Map<string, number>();
  for (const batch of batches) {
    if (batch.quantity > 0 && isExpired(batch, asOf)) {
      expiredUnits.set(
        batch.medicineId,
        (expiredUnits.get(batch.medicineId) ?? 0) + batch.quantity,
      );
    }
  }

  const lines: AllocatedLine[] = [];
  const shortfalls: AllocationShortfall[] = [];

  for (const request of merged) {
    const candidates = pool.get(request.medicineId) ?? [];
    const available = candidates.reduce((sum, b) => sum + b.quantity, 0);

    if (available < request.quantity) {
      const ignored = expiredUnits.get(request.medicineId) ?? 0;
      shortfalls.push({
        medicineId: request.medicineId,
        requested: request.quantity,
        available,
        shortBy: request.quantity - available,
        expiredUnitsIgnored: ignored,
        reason:
          available === 0
            ? ignored > 0
              ? "all-stock-expired"
              : "out-of-stock"
            : "insufficient-stock",
      });
      continue;
    }

    const picks: AllocationPick[] = [];
    let remaining = request.quantity;

    for (const batch of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      if (take <= 0) continue;

      const unitCost = batch.costPrice ?? 0;

      picks.push({
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        quantity: take,
        unitPrice: batch.salePrice,
        unitCost,
        expiryDate: batch.expiryDate,
        subtotal: round2(take * batch.salePrice),
        lineCost: round2(take * unitCost),
      });

      // Consume from the working copy so a later line sees reduced stock.
      batch.quantity -= take;
      remaining -= take;
    }

    lines.push({
      medicineId: request.medicineId,
      requestedQuantity: request.quantity,
      picks,
      lineTotal: round2(picks.reduce((sum, p) => sum + p.subtotal, 0)),
      lineCost: round2(picks.reduce((sum, p) => sum + p.lineCost, 0)),
    });
  }

  if (shortfalls.length > 0) return { ok: false, shortfalls };
  return { ok: true, lines };
}

/**
 * Collapse duplicate medicine lines and validate quantities.
 * Order of first appearance is preserved so bills read the way the cashier
 * entered them.
 */
export function mergeRequests(
  requests: readonly AllocationRequest[],
): AllocationRequest[] {
  if (requests.length === 0) {
    throw new FefoError("A sale must contain at least one item.");
  }

  const merged = new Map<string, number>();
  for (const request of requests) {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new FefoError(
        "Quantity for medicine " +
          request.medicineId +
          " must be a positive whole number.",
      );
    }
    merged.set(
      request.medicineId,
      (merged.get(request.medicineId) ?? 0) + request.quantity,
    );
  }

  return [...merged].map(([medicineId, quantity]) => ({ medicineId, quantity }));
}

/** Flatten allocated lines into the per-batch draws a sale must persist. */
export function flattenPicks(
  lines: readonly AllocatedLine[],
): Array<{ medicineId: string; pick: AllocationPick }> {
  return lines.flatMap((line) =>
    line.picks.map((pick) => ({ medicineId: line.medicineId, pick })),
  );
}

export interface BillTotalsInput {
  /** Gross value of all lines before any discount. */
  grossSubtotal: number;
  /** Absolute discount amount in rupees. */
  discount?: number;
  /**
   * Discount as a percentage of the subtotal, 0-100. When set it decides the
   * rupee amount and any `discount` passed alongside it is ignored.
   */
  discountPercent?: number;
  /** e.g. 0.13 for 13%. */
  vatRate: number;
}

export interface BillTotals {
  subtotal: number;
  discount: number;
  /** 0 when the discount was entered as a rupee amount. */
  discountPercent: number;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
}

/**
 * Nepal VAT convention: discount is applied first, VAT is charged on the
 * discounted (taxable) amount, and the total is taxable + VAT.
 *
 * A percentage discount is resolved here rather than in the browser, so the
 * counter never has to guess the subtotal: one line can be filled from two
 * batches at different prices, and only the allocation knows what it came to.
 * The resolved rupee figure is what gets stored and printed - a bill has to
 * show the money - with the percentage kept alongside it so the receipt can
 * say "10%" rather than leaving the customer to work it out.
 */
export function calculateTotals({
  grossSubtotal,
  discount = 0,
  discountPercent = 0,
  vatRate,
}: BillTotalsInput): BillTotals {
  const subtotal = round2(grossSubtotal);

  if (discountPercent < 0) {
    throw new FefoError("Discount percentage cannot be negative.");
  }
  if (discountPercent > 100) {
    throw new FefoError("A discount cannot exceed 100% of the bill.");
  }

  const appliedPercent = round2(discountPercent);
  const requested =
    appliedPercent > 0 ? round2((subtotal * appliedPercent) / 100) : discount;

  if (requested < 0) throw new FefoError("Discount cannot be negative.");
  if (requested > subtotal) {
    throw new FefoError("Discount cannot exceed the bill subtotal.");
  }
  if (vatRate < 0 || vatRate > 1) {
    throw new FefoError("VAT rate must be a fraction between 0 and 1.");
  }

  const appliedDiscount = round2(requested);
  const taxableAmount = round2(subtotal - appliedDiscount);
  const vatAmount = round2(taxableAmount * vatRate);

  return {
    subtotal,
    discount: appliedDiscount,
    discountPercent: appliedPercent,
    taxableAmount,
    vatAmount,
    totalAmount: round2(taxableAmount + vatAmount),
  };
}

/** Human-readable explanation of a failed allocation, for API error output. */
export function describeShortfall(
  shortfall: AllocationShortfall,
  medicineName?: string,
): string {
  const name = medicineName ?? "Medicine " + shortfall.medicineId;
  switch (shortfall.reason) {
    case "out-of-stock":
      return `${name} is out of stock (requested ${shortfall.requested}).`;
    case "all-stock-expired":
      return `${name} has ${shortfall.expiredUnitsIgnored} unit(s) in stock but every batch has expired, so none can be sold.`;
    case "insufficient-stock":
      return `${name} has only ${shortfall.available} unexpired unit(s) available but ${shortfall.requested} were requested (short by ${shortfall.shortBy}).`;
  }
}

// ---------------------------------------------------------------------------
// Returning stock
// ---------------------------------------------------------------------------

/** One dispensed line, as recorded on a bill. */
export interface DispensedLine {
  batchId: string;
  batchNumber: string;
  quantity: number;
}

/** Units to put back on one lot. */
export interface StockReturn {
  batchId: string;
  batchNumber: string;
  quantity: number;
}

/**
 * The inverse of allocation: what a voided bill puts back, per lot.
 *
 * Allocation merges by medicine and draws each lot once, so a bill written by
 * the sale service normally yields one entry per line. The API accepts
 * hand-built item lists though, and a bill naming the same lot twice must put
 * back the sum in a single write rather than race two increments against each
 * other. Lines with no units are dropped: an empty increment is a wasted
 * round trip and a misleading "restored" entry in the result.
 */
export function planStockReturn(
  lines: readonly DispensedLine[],
): StockReturn[] {
  const byBatch = new Map<string, StockReturn>();

  for (const line of lines) {
    if (line.quantity <= 0) continue;

    const existing = byBatch.get(line.batchId);
    if (existing) existing.quantity += line.quantity;
    else {
      byBatch.set(line.batchId, {
        batchId: line.batchId,
        batchNumber: line.batchNumber,
        quantity: line.quantity,
      });
    }
  }

  return [...byBatch.values()];
}
