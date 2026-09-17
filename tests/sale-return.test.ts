import { describe, expect, it } from "vitest";
import { FefoError } from "@/lib/fefo";
import { planSaleReturn, remainingQuantity } from "@/lib/sale-return";

const line = {
  quantity: 10,
  returnedQuantity: 0,
  unitPrice: 10,
  subtotal: 100,
  unitCost: 6,
  lineCost: 60,
  medicineId: "m1",
  medicineName: "Cetzine 10mg",
  batchId: "b1",
  batchNumber: "CTZ-2201",
  // Well in the future: these cases are about the money, not about expiry,
  // which has its own suite in return-eligibility.test.ts.
  expiryDate: new Date("2030-01-31T00:00:00.000Z"),
};

const sale = {
  items: [line],
  subtotal: 100,
  discount: 10,
  vatRate: 0.13,
};

describe("remainingQuantity", () => {
  it("is the unsold remainder of a line", () => {
    expect(remainingQuantity(line)).toBe(10);
    expect(remainingQuantity({ ...line, returnedQuantity: 4 })).toBe(6);
    expect(remainingQuantity({ ...line, returnedQuantity: null })).toBe(10);
  });
});

describe("planSaleReturn", () => {
  it("puts stock back and refunds the matching slice of the bill", () => {
    const plan = planSaleReturn(sale, [{ lineIndex: 0, quantity: 2 }]);
    expect(plan.units).toBe(2);
    expect(plan.subtotal).toBe(20);
    expect(plan.discount).toBe(2);
    expect(plan.taxableAmount).toBe(18);
    expect(plan.vatAmount).toBe(2.34);
    expect(plan.totalAmount).toBe(20.34);
    expect(plan.totalCost).toBe(12);
    expect(plan.items[0]?.batchNumber).toBe("CTZ-2201");
  });

  it("refuses more units than are still on the customer", () => {
    expect(() =>
      planSaleReturn(
        { ...sale, items: [{ ...line, returnedQuantity: 8 }] },
        [{ lineIndex: 0, quantity: 3 }],
      ),
    ).toThrow(FefoError);
  });

  it("refuses a second mention of the same line", () => {
    expect(() =>
      planSaleReturn(sale, [
        { lineIndex: 0, quantity: 1 },
        { lineIndex: 0, quantity: 1 },
      ]),
    ).toThrow(FefoError);
  });

  it("refuses an empty return", () => {
    expect(() => planSaleReturn(sale, [])).toThrow(FefoError);
  });
});

/**
 * The eligibility rules are enforced here, not only on the screen that picks
 * the lines. A hand-made request to the API must not be able to credit a
 * customer and put expired stock back in front of the next one.
 */
describe("planSaleReturn - eligibility is enforced server-side", () => {
  const NOW = new Date("2026-09-15T10:00:00.000Z");

  it("refuses an expired lot however the request was made", () => {
    const expired = {
      ...sale,
      items: [{ ...line, expiryDate: new Date("2026-09-14T00:00:00.000Z") }],
    };

    expect(() =>
      planSaleReturn(expired, [{ lineIndex: 0, quantity: 1 }], NOW),
    ).toThrow(/expired/i);
  });

  it("names the medicine and lot it refused", () => {
    const expired = {
      ...sale,
      items: [{ ...line, expiryDate: new Date("2020-01-01T00:00:00.000Z") }],
    };

    expect(() =>
      planSaleReturn(expired, [{ lineIndex: 0, quantity: 1 }], NOW),
    ).toThrow(/Cetzine 10mg \(CTZ-2201\)/);
  });

  it("still allows a lot that expires later today", () => {
    const today = {
      ...sale,
      items: [{ ...line, expiryDate: new Date("2026-09-15T23:59:00.000Z") }],
    };

    expect(
      planSaleReturn(today, [{ lineIndex: 0, quantity: 2 }], NOW).units,
    ).toBe(2);
  });

  it("refuses a line already returned in full, with a clear message", () => {
    const spent = { ...sale, items: [{ ...line, returnedQuantity: 10 }] };

    expect(() =>
      planSaleReturn(spent, [{ lineIndex: 0, quantity: 1 }], NOW),
    ).toThrow(/already returned in full/i);
  });
});
