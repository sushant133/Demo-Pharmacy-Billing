import { FefoError, round2 } from "@/lib/fefo";

/**
 * Customer returns: how many units can still come back, and what money and
 * cost that slice of the bill represented.
 *
 * The original bill is never rewritten. A return is a dated correction on
 * top of it, so the printed invoice still matches what left the counter.
 * Reports subtract the running totals stored on the sale.
 */

export interface SaleLineForReturn {
  quantity: number;
  returnedQuantity?: number | null;
  unitPrice: number;
  subtotal: number;
  unitCost: number;
  lineCost: number;
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
}

export interface ReturnRequest {
  lineIndex: number;
  quantity: number;
}

export interface PlannedReturnLine {
  lineIndex: number;
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  subtotal: number;
  discount: number;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
  lineCost: number;
}

export interface PlannedReturn {
  items: PlannedReturnLine[];
  units: number;
  subtotal: number;
  discount: number;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
  totalCost: number;
}

export function remainingQuantity(line: SaleLineForReturn): number {
  return Math.max(0, line.quantity - (line.returnedQuantity ?? 0));
}

export function planSaleReturn(
  sale: {
    items: readonly SaleLineForReturn[];
    subtotal: number;
    discount: number;
    vatRate: number;
  },
  requests: readonly ReturnRequest[],
): PlannedReturn {
  if (requests.length === 0) {
    throw new FefoError("Add at least one medicine to return.");
  }

  const used = new Set<number>();
  const items: PlannedReturnLine[] = [];

  for (const request of requests) {
    if (!Number.isInteger(request.lineIndex) || request.lineIndex < 0) {
      throw new FefoError("Return lines must name a real item on the bill.");
    }
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new FefoError("Return quantity must be a positive whole number.");
    }
    if (used.has(request.lineIndex)) {
      throw new FefoError("The same bill line cannot be returned twice in one go.");
    }
    used.add(request.lineIndex);

    const line = sale.items[request.lineIndex];
    if (!line) {
      throw new FefoError("That item is not on this bill.");
    }

    const remaining = remainingQuantity(line);
    if (request.quantity > remaining) {
      throw new FefoError(
        remaining === 0
          ? `${line.medicineName} (${line.batchNumber}) has already been returned in full.`
          : `Only ${remaining} unit(s) of ${line.medicineName} (${line.batchNumber}) can still be returned.`,
      );
    }

    const gross = round2((line.subtotal / line.quantity) * request.quantity);
    const discount =
      sale.subtotal > 0 ? round2((sale.discount * gross) / sale.subtotal) : 0;
    const taxableAmount = round2(gross - discount);
    const vatAmount = round2(taxableAmount * sale.vatRate);
    const lineCost = round2(
      line.quantity > 0 ? (line.lineCost / line.quantity) * request.quantity : 0,
    );

    items.push({
      lineIndex: request.lineIndex,
      medicineId: line.medicineId,
      medicineName: line.medicineName,
      batchId: line.batchId,
      batchNumber: line.batchNumber,
      quantity: request.quantity,
      unitPrice: line.unitPrice,
      unitCost: line.unitCost,
      subtotal: gross,
      discount,
      taxableAmount,
      vatAmount,
      totalAmount: round2(taxableAmount + vatAmount),
      lineCost,
    });
  }

  return {
    items,
    units: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: round2(items.reduce((sum, item) => sum + item.subtotal, 0)),
    discount: round2(items.reduce((sum, item) => sum + item.discount, 0)),
    taxableAmount: round2(items.reduce((sum, item) => sum + item.taxableAmount, 0)),
    vatAmount: round2(items.reduce((sum, item) => sum + item.vatAmount, 0)),
    totalAmount: round2(items.reduce((sum, item) => sum + item.totalAmount, 0)),
    totalCost: round2(items.reduce((sum, item) => sum + item.lineCost, 0)),
  };
}
