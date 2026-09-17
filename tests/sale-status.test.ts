import { describe, expect, it } from "vitest";
import {
  SALE_STATUSES,
  isSaleStatus,
  saleStatus,
  saleStatusFilter,
  saleStatusFor,
} from "@/lib/sale-status";

/**
 * The one word the sales list shows per bill.
 *
 * Its whole job is to be trusted at a glance, so the precedence between the
 * three underlying facts - voided, returned, unpaid - is pinned here rather
 * than left to whoever next edits the table markup.
 */

describe("saleStatus - precedence", () => {
  it("calls a settled bill Paid", () => {
    expect(saleStatus({ totalAmount: 1500, amountReceived: 1500 })).toMatchObject({
      status: "paid",
      label: "Paid",
      tone: "green",
      remaining: 0,
    });
  });

  it("calls a part-paid bill Pending, labelled Part paid", () => {
    expect(saleStatus({ totalAmount: 1500, amountReceived: 1000 })).toMatchObject({
      status: "pending",
      label: "Part paid",
      remaining: 500,
    });
  });

  it("calls a credit bill Pending, labelled Unpaid", () => {
    expect(saleStatus({ totalAmount: 1500, amountReceived: 0 })).toMatchObject({
      status: "pending",
      label: "Unpaid",
      tone: "rose",
      remaining: 1500,
    });
  });

  it("a void outranks everything, including an unpaid balance", () => {
    expect(
      saleStatus({
        totalAmount: 1500,
        amountReceived: 0,
        voidedAt: new Date(),
        returnedUnits: 3,
        soldUnits: 10,
      }),
    ).toMatchObject({ status: "cancelled", label: "Cancelled", remaining: 0 });
  });

  it("a return outranks payment state", () => {
    expect(
      saleStatus({
        totalAmount: 1500,
        amountReceived: 0,
        returnedUnits: 10,
        soldUnits: 10,
      }),
    ).toMatchObject({ status: "refunded", label: "Refunded" });
  });

  it("tells a part refund from a full one", () => {
    expect(
      saleStatus({
        totalAmount: 1500,
        amountReceived: 1500,
        returnedUnits: 3,
        soldUnits: 10,
      }),
    ).toMatchObject({ status: "refunded", label: "Part refunded" });
  });

  it("never reports money owed on a cancelled or refunded bill", () => {
    const cancelled = saleStatus({
      totalAmount: 1500,
      amountReceived: 0,
      voidedAt: new Date(),
    });
    const refunded = saleStatus({
      totalAmount: 1500,
      amountReceived: 0,
      returnedUnits: 10,
      soldUnits: 10,
    });
    expect(cancelled.remaining).toBe(0);
    expect(refunded.remaining).toBe(0);
  });

  it("does not invent a payment that was never recorded", () => {
    // The pure rule takes the figures at face value. Deciding that a *stored*
    // zero means "predates the ledger" rather than "nothing paid" is
    // `saleStatusFor`'s job, below, and needs the document to say so.
    expect(saleStatus({ totalAmount: 100, amountReceived: 0 }).status).toBe(
      "pending",
    );
  });
});

describe("saleStatusFilter - matches what the badges show", () => {
  it("cancelled looks only at the void", () => {
    expect(saleStatusFilter("cancelled")).toEqual({ voidedAt: { $ne: null } });
  });

  it("refunded excludes cancelled bills", () => {
    expect(saleStatusFilter("refunded")).toMatchObject({ voidedAt: null });
  });

  it("pending and paid both exclude returned and cancelled bills", () => {
    for (const status of ["pending", "paid"] as const) {
      const filter = saleStatusFilter(status);
      expect(filter).toMatchObject({
        voidedAt: null,
        returnedUnits: { $not: { $gt: 0 } },
      });
    }
  });

  it("paid accepts bills written before the payment ledger existed", () => {
    // Those rows have no paymentStatus at all, and were all paid in full.
    expect(saleStatusFilter("paid")).toMatchObject({
      $or: [{ paymentStatus: "paid" }, { paymentStatus: { $exists: false } }],
    });
  });

  it("pending requires an explicit unsettled status", () => {
    expect(saleStatusFilter("pending")).toMatchObject({
      paymentStatus: { $in: ["partial", "unpaid"] },
    });
  });

  it("covers every status the list can show", () => {
    for (const status of SALE_STATUSES) {
      expect(Object.keys(saleStatusFilter(status)).length).toBeGreaterThan(0);
    }
  });
});

describe("saleStatusFor - bills written before the payment ledger", () => {
  /**
   * The bug this pins: a bill from before the ledger can carry
   * `amountReceived: 0` - the field existed briefly before anything filled it
   * in - and believing that zero reports a paid bill as debt. The filter reads
   * such a row as paid, so the badge must too, or the dropdown returns rows
   * whose badges contradict it.
   */
  it("reads a missing paymentStatus as paid, whatever amountReceived says", () => {
    expect(
      saleStatusFor({ totalAmount: 1500, amountReceived: 0, items: [{ quantity: 2 }] }),
    ).toMatchObject({ status: "paid", remaining: 0 });

    expect(saleStatusFor({ totalAmount: 1500 })).toMatchObject({ status: "paid" });
  });

  it("believes amountReceived once a status has been recorded", () => {
    expect(
      saleStatusFor({
        totalAmount: 1500,
        amountReceived: 0,
        paymentStatus: "unpaid",
      }),
    ).toMatchObject({ status: "pending", label: "Unpaid", remaining: 1500 });

    expect(
      saleStatusFor({
        totalAmount: 1500,
        amountReceived: 1000,
        paymentStatus: "partial",
      }),
    ).toMatchObject({ status: "pending", label: "Part paid", remaining: 500 });
  });

  it("still lets a void or a return outrank a legacy bill", () => {
    expect(
      saleStatusFor({ totalAmount: 1500, voidedAt: new Date() }),
    ).toMatchObject({ status: "cancelled" });

    expect(
      saleStatusFor({
        totalAmount: 1500,
        returnedUnits: 2,
        items: [{ quantity: 2 }],
      }),
    ).toMatchObject({ status: "refunded", label: "Refunded" });
  });

  it("counts sold units from the bill's own lines", () => {
    expect(
      saleStatusFor({
        totalAmount: 1500,
        returnedUnits: 3,
        items: [{ quantity: 4 }, { quantity: 6 }],
      }),
    ).toMatchObject({ label: "Part refunded" });
  });
});

describe("isSaleStatus", () => {
  it("accepts the four statuses and rejects anything else", () => {
    for (const status of SALE_STATUSES) expect(isSaleStatus(status)).toBe(true);
    for (const value of ["", "PAID", "void", null, undefined, 1]) {
      expect(isSaleStatus(value)).toBe(false);
    }
  });
});
