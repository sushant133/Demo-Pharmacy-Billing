import { describe, expect, it } from "vitest";
import {
  PAYMENT_STATUS_LABELS,
  givesChange,
  settleSale,
} from "@/lib/sale-payment";

/**
 * What a bill is still owed.
 *
 * Every figure the counter reads - and every customer-due total that follows
 * from it - comes through here, so the worked examples from the counter are
 * pinned directly.
 */

describe("settleSale - the counter's four cases", () => {
  it("full payment leaves nothing owing", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 1500 });
    expect(result).toMatchObject({
      totalDue: 1500,
      paid: 1500,
      remaining: 0,
      change: 0,
      status: "paid",
      settled: true,
    });
  });

  it("part payment leaves the balance owing", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 1000 });
    expect(result).toMatchObject({
      totalDue: 1500,
      paid: 1000,
      remaining: 500,
      change: 0,
      status: "partial",
      settled: false,
    });
  });

  it("nothing received is a credit sale, not a part payment", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 0 });
    expect(result).toMatchObject({
      totalDue: 1500,
      paid: 0,
      remaining: 1500,
      status: "unpaid",
      settled: false,
    });
  });

  it("overpayment is change, never a negative debt", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 2000 });
    expect(result).toMatchObject({
      totalDue: 1500,
      paid: 2000,
      remaining: 0,
      change: 500,
      status: "paid",
      settled: true,
    });
  });
});

describe("settleSale - returns and voids", () => {
  it("a return reduces what is owed", () => {
    // Billed 1500, paid 1000, then 500 of goods came back: nothing left owing.
    const result = settleSale({
      totalAmount: 1500,
      amountReceived: 1000,
      returnedTotal: 500,
    });
    expect(result.totalDue).toBe(1000);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe("paid");
  });

  it("a return can turn a part payment into an overpayment", () => {
    const result = settleSale({
      totalAmount: 1500,
      amountReceived: 1000,
      returnedTotal: 900,
    });
    expect(result.totalDue).toBe(600);
    expect(result.change).toBe(400);
    expect(result.remaining).toBe(0);
  });

  it("a voided bill is owed nothing", () => {
    const result = settleSale({
      totalAmount: 1500,
      amountReceived: 0,
      voidedAt: new Date(),
    });
    expect(result.totalDue).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe("paid");
  });
});

describe("settleSale - money precision", () => {
  it("does not leave a phantom rupee from float drift", () => {
    const result = settleSale({ totalAmount: 0.1 + 0.2, amountReceived: 0.3 });
    expect(result.remaining).toBe(0);
    expect(result.status).toBe("paid");
  });

  it("treats a sub-paisa shortfall as settled", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 1499.999 });
    expect(result.remaining).toBe(0);
    expect(result.status).toBe("paid");
  });

  it("does not treat a one-paisa shortfall as settled", () => {
    const result = settleSale({ totalAmount: 1500, amountReceived: 1499.99 });
    expect(result.remaining).toBe(0.01);
    expect(result.status).toBe("partial");
  });

  it("never reports a negative balance as debt", () => {
    const result = settleSale({ totalAmount: 100, amountReceived: 250 });
    expect(result.remaining).toBe(0);
    expect(result.change).toBe(150);
  });
});

describe("givesChange", () => {
  it("is cash only - a transfer over the total is an error, not change", () => {
    expect(givesChange("cash")).toBe(true);
    for (const method of ["card", "esewa", "khalti", "bank", "credit"]) {
      expect(givesChange(method)).toBe(false);
    }
  });
});

describe("PAYMENT_STATUS_LABELS", () => {
  it("names every status the counter can see", () => {
    expect(PAYMENT_STATUS_LABELS.paid).toBe("Paid");
    expect(PAYMENT_STATUS_LABELS.partial).toBe("Partially paid");
    expect(PAYMENT_STATUS_LABELS.unpaid).toBe("Credit / Unpaid");
  });
});
