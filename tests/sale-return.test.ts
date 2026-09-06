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
