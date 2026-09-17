import { describe, expect, it } from "vitest";
import { purchasePostSchema, purchaseSchema } from "@/lib/validation";

/**
 * What a delivery may say before it is allowed near the stock service.
 *
 * These are the rules that stop a mistyped invoice becoming a bad batch. The
 * service re-checks the ones that matter for stock, but a message that names
 * the field and the line is only possible here.
 */

const MEDICINE = "507f1f77bcf86cd799439011";
const OTHER_MEDICINE = "507f1f77bcf86cd799439012";
const SUPPLIER = "507f1f77bcf86cd799439013";

function line(overrides: Record<string, unknown> = {}) {
  return {
    medicineId: MEDICINE,
    batchNumber: "CTZ-2205",
    mfgDate: "2026-01-01",
    expiryDate: "2028-01-31",
    quantity: 100,
    freeQuantity: 0,
    costPrice: 1.2,
    salePrice: 2.5,
    discount: 0,
    ...overrides,
  };
}

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    invoiceNo: "INV-001",
    receivedDate: "2026-09-16",
    items: [line()],
    discount: 0,
    otherCharges: 0,
    vatRate: 0.13,
    notes: "",
    ...overrides,
  };
}

describe("purchaseSchema basics", () => {
  it("accepts a well-formed delivery", () => {
    expect(purchaseSchema.safeParse(purchase()).success).toBe(true);
  });

  it("requires at least one line", () => {
    const result = purchaseSchema.safeParse(purchase({ items: [] }));
    expect(result.success).toBe(false);
  });

  it("refuses a negative quantity", () => {
    expect(
      purchaseSchema.safeParse(purchase({ items: [line({ quantity: -5 })] }))
        .success,
    ).toBe(false);
  });

  it("refuses a negative price", () => {
    expect(
      purchaseSchema.safeParse(purchase({ items: [line({ costPrice: -1 })] }))
        .success,
    ).toBe(false);
  });

  it("refuses a line receiving nothing at all", () => {
    const result = purchaseSchema.safeParse(
      purchase({ items: [line({ quantity: 0, freeQuantity: 0 })] }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a free-only line", () => {
    // "10 + 2 free" on a separate line is real, and those units still arrive.
    expect(
      purchaseSchema.safeParse(
        purchase({ items: [line({ quantity: 0, freeQuantity: 12 })] }),
      ).success,
    ).toBe(true);
  });

  it("refuses an expiry before the manufacturing date", () => {
    const result = purchaseSchema.safeParse(
      purchase({
        items: [line({ mfgDate: "2028-01-01", expiryDate: "2026-01-01" })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("treats a VAT rate as a fraction, not a percentage", () => {
    expect(purchaseSchema.safeParse(purchase({ vatRate: 0.13 })).success).toBe(true);
    // 13 would be 1300%, which is a units mistake worth catching.
    expect(purchaseSchema.safeParse(purchase({ vatRate: 13 })).success).toBe(false);
  });
});

/*
  Duplicate lots.
  ---------------
  Two lines of the same medicine under one lot number would post as a single
  blended batch, averaging two costs and two expiry dates into a lot matching
  neither line. The service refuses it too; doing it here as well is what lets
  the form put the error on the offending line.
*/
describe("duplicate lot numbers", () => {
  it("refuses the same lot twice for the same medicine", () => {
    const result = purchaseSchema.safeParse(
      purchase({ items: [line(), line()] }),
    );
    expect(result.success).toBe(false);
  });

  it("matches lot numbers case-insensitively", () => {
    const result = purchaseSchema.safeParse(
      purchase({ items: [line({ batchNumber: "ctz-2205" }), line()] }),
    );
    expect(result.success).toBe(false);
  });

  it("names the earlier line so the user can find it", () => {
    const result = purchaseSchema.safeParse(
      purchase({ items: [line(), line()] }),
    );
    if (result.success) throw new Error("expected a failure");
    expect(result.error.issues[0]!.message).toMatch(/line 1/i);
    expect(result.error.issues[0]!.path).toEqual(["items", 1, "batchNumber"]);
  });

  it("allows the same lot number under a different medicine", () => {
    // Lot numbers are the manufacturer's, not the shop's, and two makers reuse
    // them freely. Refusing this would block real deliveries.
    const result = purchaseSchema.safeParse(
      purchase({
        items: [line(), line({ medicineId: OTHER_MEDICINE })],
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("credit terms", () => {
  it("treats blank as 'use the supplier's terms'", () => {
    const result = purchaseSchema.parse(purchase({ creditDays: "" }));
    expect(result.creditDays).toBeNull();
  });

  it("keeps zero, which means due on receipt", () => {
    // Zero must survive as 0 rather than collapsing to null, or a cash-on-
    // delivery supplier would silently inherit a 30-day term.
    const result = purchaseSchema.parse(purchase({ creditDays: 0 }));
    expect(result.creditDays).toBe(0);
  });

  it("accepts a real term and refuses an absurd one", () => {
    expect(purchaseSchema.parse(purchase({ creditDays: 45 })).creditDays).toBe(45);
    expect(purchaseSchema.safeParse(purchase({ creditDays: 400 })).success).toBe(
      false,
    );
    expect(purchaseSchema.safeParse(purchase({ creditDays: -1 })).success).toBe(
      false,
    );
  });
});

describe("payment on the delivery", () => {
  it("is optional", () => {
    expect(purchaseSchema.parse(purchase()).payment).toBeUndefined();
  });

  it("carries the amount, method and reference", () => {
    const result = purchaseSchema.parse(
      purchase({
        payment: { amount: 500, method: "bank-transfer", reference: "TXN-99" },
      }),
    );
    expect(result.payment).toEqual({
      amount: 500,
      method: "bank-transfer",
      reference: "TXN-99",
    });
  });

  it("defaults the method to cash", () => {
    const result = purchaseSchema.parse(purchase({ payment: { amount: 100 } }));
    expect(result.payment?.method).toBe("cash");
  });

  it("refuses a negative amount", () => {
    expect(
      purchaseSchema.safeParse(purchase({ payment: { amount: -1 } })).success,
    ).toBe(false);
  });
});

describe("purchasePostSchema", () => {
  it("accepts an empty body, which is how posting usually happens", () => {
    expect(purchasePostSchema.safeParse({}).success).toBe(true);
    expect(purchasePostSchema.parse({}).payment).toBeUndefined();
  });

  it("accepts a payment made at the door", () => {
    const result = purchasePostSchema.parse({
      payment: { amount: 250, method: "cheque", reference: "CHQ-4" },
    });
    expect(result.payment?.amount).toBe(250);
    expect(result.payment?.method).toBe("cheque");
  });

  it("refuses a negative payment", () => {
    expect(
      purchasePostSchema.safeParse({ payment: { amount: -10 } }).success,
    ).toBe(false);
  });
});
