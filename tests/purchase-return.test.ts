import { describe, expect, it } from "vitest";
import {
  PURCHASE_RETURN_REASONS,
  PurchaseReturnError,
  isPurchaseReturnReason,
  planPurchaseReturn,
  purchaseLineEligibility,
  type PurchaseLineForReturn,
} from "@/lib/purchase-return";

/** A delivered line with 100 received, none back yet, all still on the shelf. */
function line(
  overrides: Partial<PurchaseLineForReturn> = {},
): PurchaseLineForReturn {
  return {
    receivedQuantity: 100,
    returnedQuantity: 0,
    onHandQuantity: 100,
    effectiveUnitCost: 2.5,
    medicineId: "m1",
    medicineName: "Cetzine 10mg",
    batchId: "b1",
    batchNumber: "CTZ-2205",
    ...overrides,
  };
}

describe("purchaseLineEligibility", () => {
  it("allows the full delivery back when nothing has moved", () => {
    expect(purchaseLineEligibility(line(), "posted")).toEqual({
      eligible: true,
      returnable: 100,
      reason: null,
    });
  });

  it("refuses a draft, which has no stock behind it", () => {
    const result = purchaseLineEligibility(line(), "draft");
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("not-posted");
  });

  it("refuses a cancelled GRN, whose stock was already reversed", () => {
    const result = purchaseLineEligibility(line(), "cancelled");
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("cancelled");
  });

  it("subtracts what has already gone back", () => {
    expect(
      purchaseLineEligibility(line({ returnedQuantity: 30 }), "posted")
        .returnable,
    ).toBe(70);
  });

  it("closes the line once everything has gone back", () => {
    const result = purchaseLineEligibility(
      line({ returnedQuantity: 100 }),
      "posted",
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("fully-returned");
  });

  /*
    The rule that makes a purchase return different from a customer return.
    Units already dispensed are with a patient, so the shelf - not the invoice
    - is the binding limit.
  */
  it("caps at what is physically left on the shelf", () => {
    expect(
      purchaseLineEligibility(line({ onHandQuantity: 20 }), "posted").returnable,
    ).toBe(20);
  });

  it("refuses outright when the lot has been sold out", () => {
    const result = purchaseLineEligibility(
      line({ onHandQuantity: 0 }),
      "posted",
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("no-stock-left");
  });

  it("takes whichever limit binds first", () => {
    // 40 left on the invoice, 25 on the shelf.
    expect(
      purchaseLineEligibility(
        line({ returnedQuantity: 60, onHandQuantity: 25 }),
        "posted",
      ).returnable,
    ).toBe(25);

    // 10 left on the invoice, 80 on the shelf.
    expect(
      purchaseLineEligibility(
        line({ returnedQuantity: 90, onHandQuantity: 80 }),
        "posted",
      ).returnable,
    ).toBe(10);
  });
});

describe("planPurchaseReturn", () => {
  const purchase = {
    status: "posted",
    items: [
      line(),
      line({
        medicineId: "m2",
        medicineName: "Omez 20mg",
        batchId: "b2",
        batchNumber: "OMZ-1120",
        receivedQuantity: 50,
        onHandQuantity: 50,
        effectiveUnitCost: 4,
      }),
    ],
  };

  it("costs a single line at its effective unit cost", () => {
    const plan = planPurchaseReturn(purchase, [
      { lineIndex: 0, quantity: 10 },
    ]);
    expect(plan.units).toBe(10);
    expect(plan.totalAmount).toBe(25);
    expect(plan.items[0]!.batchId).toBe("b1");
  });

  it("totals across lines", () => {
    const plan = planPurchaseReturn(purchase, [
      { lineIndex: 0, quantity: 10 }, // 25.00
      { lineIndex: 1, quantity: 5 }, // 20.00
    ]);
    expect(plan.units).toBe(15);
    expect(plan.totalAmount).toBe(45);
  });

  it("ignores zero-quantity rows", () => {
    const plan = planPurchaseReturn(purchase, [
      { lineIndex: 0, quantity: 10 },
      { lineIndex: 1, quantity: 0 },
    ]);
    expect(plan.items).toHaveLength(1);
  });

  it("refuses a request with nothing in it", () => {
    expect(() => planPurchaseReturn(purchase, [])).toThrow(PurchaseReturnError);
    expect(() =>
      planPurchaseReturn(purchase, [{ lineIndex: 0, quantity: 0 }]),
    ).toThrow(/how many units/i);
  });

  /*
    Two rows naming the same line would each pass the per-line check and
    together exceed it. Folding them before validation is what stops a
    duplicated row returning 150 of a 100-unit line.
  */
  it("folds duplicate rows for one line before checking the limit", () => {
    const plan = planPurchaseReturn(purchase, [
      { lineIndex: 0, quantity: 60 },
      { lineIndex: 0, quantity: 30 },
    ]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.quantity).toBe(90);

    expect(() =>
      planPurchaseReturn(purchase, [
        { lineIndex: 0, quantity: 60 },
        { lineIndex: 0, quantity: 60 },
      ]),
    ).toThrow(/only 100/i);
  });

  it("names the medicine when it refuses", () => {
    expect(() =>
      planPurchaseReturn(purchase, [{ lineIndex: 1, quantity: 51 }]),
    ).toThrow(/Omez 20mg/);
  });

  it("refuses a line that is not on the delivery", () => {
    expect(() =>
      planPurchaseReturn(purchase, [{ lineIndex: 7, quantity: 1 }]),
    ).toThrow(/not on this delivery/i);
  });

  it("refuses fractional units", () => {
    expect(() =>
      planPurchaseReturn(purchase, [{ lineIndex: 0, quantity: 2.5 }]),
    ).toThrow(/whole units/i);
  });

  it("refuses a line with no lot behind it", () => {
    expect(() =>
      planPurchaseReturn(
        { status: "posted", items: [line({ batchId: null })] },
        [{ lineIndex: 0, quantity: 1 }],
      ),
    ).toThrow(/no lot on the shelf/i);
  });

  it("refuses against a draft", () => {
    expect(() =>
      planPurchaseReturn({ status: "draft", items: [line()] }, [
        { lineIndex: 0, quantity: 1 },
      ]),
    ).toThrow(/has not been posted/i);
  });

  it("lists lines in invoice order whatever order they were sent in", () => {
    const plan = planPurchaseReturn(purchase, [
      { lineIndex: 1, quantity: 5 },
      { lineIndex: 0, quantity: 5 },
    ]);
    expect(plan.items.map((item) => item.lineIndex)).toEqual([0, 1]);
  });

  it("rounds money to two places", () => {
    const plan = planPurchaseReturn(
      { status: "posted", items: [line({ effectiveUnitCost: 1.111 })] },
      [{ lineIndex: 0, quantity: 3 }],
    );
    expect(plan.totalAmount).toBe(3.33);
  });

  /*
    Effective unit costs are routinely thirds of a rupee once free units and
    invoice discount are spread across a line, so the running total has to be
    re-rounded at each step rather than only at the end - otherwise binary
    float error accumulates across a ten-line delivery and the debit note
    disagrees with the sum of its own rows.
  */
  it("keeps the total equal to the sum of its rows", () => {
    const thirds = { status: "posted", items: [line({ effectiveUnitCost: 0.1 })] };
    const plan = planPurchaseReturn(thirds, [{ lineIndex: 0, quantity: 3 }]);

    expect(plan.totalAmount).toBe(0.3);
    expect(plan.totalAmount).toBe(
      plan.items.reduce((sum, item) => sum + item.lineTotal, 0),
    );
  });
});

describe("PURCHASE_RETURN_REASONS", () => {
  it("recognises its own codes and nothing else", () => {
    for (const reason of PURCHASE_RETURN_REASONS) {
      expect(isPurchaseReturnReason(reason.code), reason.code).toBe(true);
    }
    expect(isPurchaseReturnReason("changed-mind")).toBe(false);
    expect(isPurchaseReturnReason("")).toBe(false);
    expect(isPurchaseReturnReason(undefined)).toBe(false);
  });

  it("gives every reason a label", () => {
    for (const reason of PURCHASE_RETURN_REASONS) {
      expect(reason.label.length).toBeGreaterThan(3);
    }
  });
});
