import { describe, expect, it } from "vitest";
import { allocateFefo, planStockReturn, type AllocatableBatch } from "@/lib/fefo";

/**
 * Returning stock is the inverse of allocating it, and the two have to agree:
 * whatever a bill took off the shelf, voiding it must put back on the same
 * lots in the same quantities. That round trip is the property worth pinning
 * down, so most of these tests allocate first and return the result.
 */

const JAN = new Date("2026-01-15T00:00:00Z");

function batch(
  batchId: string,
  overrides: Partial<AllocatableBatch> = {},
): AllocatableBatch {
  return {
    batchId,
    medicineId: "med-1",
    batchNumber: `LOT-${batchId}`,
    quantity: 100,
    salePrice: 10,
    costPrice: 6,
    expiryDate: new Date("2027-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("planStockReturn", () => {
  it("returns nothing for a bill with no lines", () => {
    expect(planStockReturn([])).toEqual([]);
  });

  it("maps a single line straight back to its lot", () => {
    expect(
      planStockReturn([{ batchId: "b1", batchNumber: "LOT-b1", quantity: 12 }]),
    ).toEqual([{ batchId: "b1", batchNumber: "LOT-b1", quantity: 12 }]);
  });

  it("keeps separate lots separate", () => {
    const result = planStockReturn([
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 5 },
      { batchId: "b2", batchNumber: "LOT-b2", quantity: 7 },
    ]);

    expect(result).toEqual([
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 5 },
      { batchId: "b2", batchNumber: "LOT-b2", quantity: 7 },
    ]);
  });

  it("sums repeated lots into one restore", () => {
    // Two lines naming the same lot must produce one increment, not two that
    // could interleave with a concurrent sale from the same batch.
    const result = planStockReturn([
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 5 },
      { batchId: "b2", batchNumber: "LOT-b2", quantity: 7 },
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 3 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ batchId: "b1", batchNumber: "LOT-b1", quantity: 8 });
    expect(result[1]).toEqual({ batchId: "b2", batchNumber: "LOT-b2", quantity: 7 });
  });

  it("preserves the order lots first appear in", () => {
    const result = planStockReturn([
      { batchId: "b3", batchNumber: "LOT-b3", quantity: 1 },
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 1 },
      { batchId: "b3", batchNumber: "LOT-b3", quantity: 1 },
    ]);

    expect(result.map((entry) => entry.batchId)).toEqual(["b3", "b1"]);
  });

  it("drops zero-quantity lines rather than issuing an empty write", () => {
    const result = planStockReturn([
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 0 },
      { batchId: "b2", batchNumber: "LOT-b2", quantity: 4 },
    ]);

    expect(result).toEqual([{ batchId: "b2", batchNumber: "LOT-b2", quantity: 4 }]);
  });

  it("ignores a negative quantity instead of stealing stock", () => {
    // Nothing should ever write one, but a bad line must not turn a restore
    // into a silent deduction.
    expect(
      planStockReturn([{ batchId: "b1", batchNumber: "LOT-b1", quantity: -5 }]),
    ).toEqual([]);
  });

  it("does not mutate the lines it was given", () => {
    const lines = [
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 5 },
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 3 },
    ];
    const snapshot = structuredClone(lines);

    planStockReturn(lines);

    expect(lines).toEqual(snapshot);
  });
});

describe("allocate then return", () => {
  it("puts back exactly what a single-lot line took", () => {
    const result = allocateFefo(
      [{ medicineId: "med-1", quantity: 30 }],
      [batch("b1")],
      JAN,
    );
    if (!result.ok) throw new Error("allocation should have succeeded");

    const dispensed = result.lines.flatMap((line) => line.picks);
    const returns = planStockReturn(dispensed);

    expect(returns).toEqual([{ batchId: "b1", batchNumber: "LOT-b1", quantity: 30 }]);
  });

  it("puts back each side of a FEFO split on its own lot", () => {
    const near = batch("b1", {
      quantity: 40,
      expiryDate: new Date("2026-03-01T00:00:00Z"),
    });
    const far = batch("b2", {
      quantity: 100,
      expiryDate: new Date("2027-06-01T00:00:00Z"),
    });

    const result = allocateFefo([{ medicineId: "med-1", quantity: 60 }], [near, far], JAN);
    if (!result.ok) throw new Error("allocation should have succeeded");

    const returns = planStockReturn(result.lines.flatMap((line) => line.picks));

    // 40 off the earliest-expiry lot, the remaining 20 off the next.
    expect(returns).toEqual([
      { batchId: "b1", batchNumber: "LOT-b1", quantity: 40 },
      { batchId: "b2", batchNumber: "LOT-b2", quantity: 20 },
    ]);
  });

  it("restores every lot to its pre-sale quantity across several medicines", () => {
    const batches = [
      batch("b1", { quantity: 50, expiryDate: new Date("2026-04-01T00:00:00Z") }),
      batch("b2", { quantity: 50, expiryDate: new Date("2027-04-01T00:00:00Z") }),
      batch("b3", { medicineId: "med-2", quantity: 80 }),
    ];
    const before = new Map(batches.map((b) => [b.batchId, b.quantity]));

    const result = allocateFefo(
      [
        { medicineId: "med-1", quantity: 70 },
        { medicineId: "med-2", quantity: 25 },
      ],
      batches,
      JAN,
    );
    if (!result.ok) throw new Error("allocation should have succeeded");

    const picks = result.lines.flatMap((line) => line.picks);

    // Apply the sale, then the void, and check every lot is back where it was.
    const after = new Map(before);
    for (const pick of picks) {
      after.set(pick.batchId, (after.get(pick.batchId) ?? 0) - pick.quantity);
    }
    for (const entry of planStockReturn(picks)) {
      after.set(entry.batchId, (after.get(entry.batchId) ?? 0) + entry.quantity);
    }

    expect(after).toEqual(before);
  });

  it("returns units to a lot that has since expired rather than losing them", () => {
    // A lot can expire between the sale and the void. The planner is expiry-
    // blind on purpose: the units physically come back, so the count must show
    // them, and allocateFefo is what refuses to sell them again.
    const expired = batch("b1", {
      quantity: 20,
      expiryDate: new Date("2026-02-01T00:00:00Z"),
    });

    const sold = allocateFefo([{ medicineId: "med-1", quantity: 9 }], [expired], JAN);
    if (!sold.ok) throw new Error("allocation should have succeeded");

    const returns = planStockReturn(sold.lines.flatMap((line) => line.picks));
    expect(returns).toEqual([{ batchId: "b1", batchNumber: "LOT-b1", quantity: 9 }]);

    // Two months later the same lot can no longer be dispensed...
    const later = new Date("2026-03-15T00:00:00Z");
    const resold = allocateFefo([{ medicineId: "med-1", quantity: 9 }], [expired], later);
    expect(resold.ok).toBe(false);
  });
});
