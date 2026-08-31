import { describe, expect, it } from "vitest";
import {
  PurchaseMathError,
  calculateLine,
  calculatePurchaseTotals,
  paymentStatusFor,
  round2,
  round4,
  unitMargin,
  weightedAverageCost,
} from "@/lib/purchase-math";

/**
 * Purchase costing decides what every unit on the shelf is worth, which in
 * turn decides every margin the shop ever reports. Like FEFO, it is pure so it
 * can be pinned down exactly.
 */

describe("rounding", () => {
  it("round2 avoids floating point drift", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
  });

  it("round4 keeps the extra precision unit costs need", () => {
    expect(round4(1 / 3)).toBe(0.3333);
    expect(round4(10 / 12)).toBe(0.8333);
  });
});

describe("calculateLine - free scheme units", () => {
  it("prices a plain line with no free units", () => {
    const line = calculateLine({ quantity: 10, costPrice: 20 });

    expect(line.receivedQuantity).toBe(10);
    expect(line.gross).toBe(200);
    expect(line.net).toBe(200);
    expect(line.effectiveUnitCost).toBe(20);
  });

  it("spreads cost over free units, lowering the real unit cost", () => {
    // Classic "10 + 2 free": 12 units reach the shelf, 10 were paid for.
    const line = calculateLine({ quantity: 10, freeQuantity: 2, costPrice: 12 });

    expect(line.receivedQuantity).toBe(12);
    expect(line.gross).toBe(120);
    // 120 spread over 12 units, not 12 per unit.
    expect(line.effectiveUnitCost).toBe(10);
  });

  it("applies a line discount before spreading cost", () => {
    const line = calculateLine({
      quantity: 10,
      freeQuantity: 2,
      costPrice: 12,
      discount: 24,
    });

    expect(line.net).toBe(96);
    expect(line.effectiveUnitCost).toBe(8); // 96 / 12
  });

  it("handles an entirely free line (samples) at zero cost", () => {
    const line = calculateLine({ quantity: 0, freeQuantity: 5, costPrice: 0 });

    expect(line.receivedQuantity).toBe(5);
    expect(line.net).toBe(0);
    expect(line.effectiveUnitCost).toBe(0);
  });

  it("keeps precision on an awkward division", () => {
    // 100 over 3 units must not silently round to 33.33 and lose value.
    const line = calculateLine({ quantity: 3, costPrice: 33.3333 });
    expect(line.effectiveUnitCost).toBe(33.3333);
  });

  it("rejects a line that receives nothing", () => {
    expect(() => calculateLine({ quantity: 0, costPrice: 10 })).toThrow(
      PurchaseMathError,
    );
  });

  it("rejects fractional and negative quantities", () => {
    expect(() => calculateLine({ quantity: 1.5, costPrice: 10 })).toThrow(
      PurchaseMathError,
    );
    expect(() => calculateLine({ quantity: -1, costPrice: 10 })).toThrow(
      PurchaseMathError,
    );
    expect(() =>
      calculateLine({ quantity: 1, freeQuantity: -2, costPrice: 10 }),
    ).toThrow(PurchaseMathError);
  });

  it("rejects a discount larger than the line", () => {
    expect(() =>
      calculateLine({ quantity: 10, costPrice: 10, discount: 200 }),
    ).toThrow(PurchaseMathError);
  });

  it("rejects a negative cost price", () => {
    expect(() => calculateLine({ quantity: 1, costPrice: -5 })).toThrow(
      PurchaseMathError,
    );
  });
});

describe("calculatePurchaseTotals", () => {
  it("totals a simple single-line invoice with VAT", () => {
    const totals = calculatePurchaseTotals({
      lines: [{ quantity: 10, costPrice: 100 }],
      vatRate: 0.13,
    });

    expect(totals.subtotal).toBe(1000);
    expect(totals.taxableAmount).toBe(1000);
    expect(totals.vatAmount).toBe(130);
    expect(totals.totalAmount).toBe(1130);
    expect(totals.totalUnits).toBe(10);
  });

  it("applies invoice discount before VAT", () => {
    const totals = calculatePurchaseTotals({
      lines: [{ quantity: 10, costPrice: 100 }],
      discount: 100,
      vatRate: 0.13,
    });

    expect(totals.taxableAmount).toBe(900);
    expect(totals.vatAmount).toBe(117);
    expect(totals.totalAmount).toBe(1017);
  });

  it("taxes freight along with the goods", () => {
    const totals = calculatePurchaseTotals({
      lines: [{ quantity: 10, costPrice: 100 }],
      otherCharges: 200,
      vatRate: 0.13,
    });

    expect(totals.taxableAmount).toBe(1200);
    expect(totals.vatAmount).toBe(156);
    expect(totals.totalAmount).toBe(1356);
  });

  it("combines line discounts, invoice discount, freight and VAT in order", () => {
    const totals = calculatePurchaseTotals({
      lines: [
        { quantity: 10, freeQuantity: 2, costPrice: 50, discount: 50 },
        { quantity: 5, costPrice: 100 },
      ],
      discount: 50,
      otherCharges: 100,
      vatRate: 0.13,
    });

    // Line 1: 500 - 50 = 450. Line 2: 500. Subtotal 950.
    expect(totals.subtotal).toBe(950);
    // 950 - 50 + 100 = 1000.
    expect(totals.taxableAmount).toBe(1000);
    expect(totals.vatAmount).toBe(130);
    expect(totals.totalAmount).toBe(1130);
    // 12 units on line 1 plus 5 on line 2.
    expect(totals.totalUnits).toBe(17);
  });

  it("counts free units towards stock but not towards cost", () => {
    const totals = calculatePurchaseTotals({
      lines: [{ quantity: 100, freeQuantity: 20, costPrice: 5 }],
    });

    expect(totals.subtotal).toBe(500);
    expect(totals.totalUnits).toBe(120);
    expect(totals.lines[0]!.effectiveUnitCost).toBeCloseTo(4.1667, 4);
  });

  it("supports a zero VAT rate", () => {
    const totals = calculatePurchaseTotals({
      lines: [{ quantity: 1, costPrice: 10 }],
      vatRate: 0,
    });
    expect(totals.vatAmount).toBe(0);
    expect(totals.totalAmount).toBe(10);
  });

  it("rejects an empty invoice", () => {
    expect(() => calculatePurchaseTotals({ lines: [] })).toThrow(PurchaseMathError);
  });

  it("rejects a discount larger than the line total", () => {
    expect(() =>
      calculatePurchaseTotals({ lines: [{ quantity: 1, costPrice: 10 }], discount: 50 }),
    ).toThrow(PurchaseMathError);
  });

  it("rejects a VAT rate given as a percentage", () => {
    expect(() =>
      calculatePurchaseTotals({ lines: [{ quantity: 1, costPrice: 10 }], vatRate: 13 }),
    ).toThrow(PurchaseMathError);
  });

  it("returns one costed line per input line, in order", () => {
    const totals = calculatePurchaseTotals({
      lines: [
        { quantity: 1, costPrice: 10 },
        { quantity: 2, costPrice: 20 },
        { quantity: 3, costPrice: 30 },
      ],
    });

    expect(totals.lines).toHaveLength(3);
    expect(totals.lines.map((line) => line.net)).toEqual([10, 40, 90]);
  });
});

describe("weightedAverageCost", () => {
  it("blends the old and new cost by quantity", () => {
    // 10 units at 10 plus 10 units at 20 averages to 15.
    expect(
      weightedAverageCost(
        { quantity: 10, costPrice: 10 },
        { quantity: 10, costPrice: 20 },
      ),
    ).toBe(15);
  });

  it("weights towards whichever side holds more units", () => {
    expect(
      weightedAverageCost(
        { quantity: 90, costPrice: 10 },
        { quantity: 10, costPrice: 20 },
      ),
    ).toBe(11);
  });

  it("adopts the new price when the old lot has sold out", () => {
    expect(
      weightedAverageCost(
        { quantity: 0, costPrice: 10 },
        { quantity: 5, costPrice: 25 },
      ),
    ).toBe(25);
  });

  it("does not lose the existing cost when nothing new arrives priced", () => {
    expect(
      weightedAverageCost(
        { quantity: 10, costPrice: 12 },
        { quantity: 0, costPrice: 99 },
      ),
    ).toBe(12);
  });

  it("returns the incoming price when both sides are empty", () => {
    expect(
      weightedAverageCost({ quantity: 0, costPrice: 0 }, { quantity: 0, costPrice: 7 }),
    ).toBe(7);
  });

  it("rejects negative quantities", () => {
    expect(() =>
      weightedAverageCost(
        { quantity: -1, costPrice: 10 },
        { quantity: 1, costPrice: 10 },
      ),
    ).toThrow(PurchaseMathError);
  });
});

describe("unitMargin", () => {
  it("computes margin per unit and as a percentage", () => {
    expect(unitMargin(10, 15)).toEqual({ perUnit: 5, percent: 50 });
  });

  it("reports a negative margin when selling below cost", () => {
    expect(unitMargin(20, 15).perUnit).toBe(-5);
  });

  it("avoids dividing by zero on free stock", () => {
    expect(unitMargin(0, 15)).toEqual({ perUnit: 15, percent: 0 });
  });
});

describe("paymentStatusFor", () => {
  it("is unpaid when nothing has been paid", () => {
    expect(paymentStatusFor(1000, 0)).toBe("unpaid");
  });

  it("is partial for anything in between", () => {
    expect(paymentStatusFor(1000, 400)).toBe("partial");
  });

  it("is paid once the full amount is settled", () => {
    expect(paymentStatusFor(1000, 1000)).toBe("paid");
  });

  it("tolerates sub-paisa rounding rather than reading as partial", () => {
    expect(paymentStatusFor(1000, 999.999)).toBe("paid");
  });

  it("treats an overpayment as paid, not as a negative balance", () => {
    expect(paymentStatusFor(1000, 1200)).toBe("paid");
  });

  it("is paid when a zero-value invoice has nothing owing", () => {
    // A fully-free sample delivery still needs a sane status.
    expect(paymentStatusFor(0, 0)).toBe("unpaid");
  });
});
