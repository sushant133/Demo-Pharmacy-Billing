import { describe, expect, it } from "vitest";
import {
  REFUND_METHODS,
  RETURN_REASONS,
  defaultRefundMethod,
  isExpiredForReturn,
  isRefundMethod,
  isReturnReason,
  refundMethodsFor,
  refundSplit,
  remainingUnits,
  returnEligibility,
} from "@/lib/return-eligibility";

/**
 * What may come back over the counter.
 *
 * The consequence of getting this wrong is not a wrong number on a report:
 * it is expired or already-credited medicine going back on a shelf and being
 * dispensed to the next customer. Pinned accordingly.
 */

const NOW = new Date("2026-09-15T10:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const line = (over: Partial<Parameters<typeof returnEligibility>[0]> = {}) => ({
  quantity: 10,
  returnedQuantity: 0,
  expiryDate: days(365),
  saleVoided: false,
  ...over,
});

describe("returnEligibility", () => {
  it("accepts a live line from a completed sale", () => {
    expect(returnEligibility(line(), NOW)).toEqual({
      eligible: true,
      returnable: 10,
      reason: null,
      message: "",
    });
  });

  it("offers only the units not already returned", () => {
    expect(returnEligibility(line({ returnedQuantity: 4 }), NOW)).toMatchObject({
      eligible: true,
      returnable: 6,
    });
  });

  it("refuses a line that has come back in full", () => {
    expect(returnEligibility(line({ returnedQuantity: 10 }), NOW)).toMatchObject({
      eligible: false,
      returnable: 0,
      reason: "fully-returned",
    });
  });

  it("refuses an expired lot, however recent the sale", () => {
    const result = returnEligibility(line({ expiryDate: days(-1) }), NOW);
    expect(result).toMatchObject({ eligible: false, reason: "expired" });
    // And says what to do instead, rather than only refusing.
    expect(result.message).toMatch(/write it off/i);
  });

  it("accepts a lot expiring today - it is sellable until the day is out", () => {
    expect(returnEligibility(line({ expiryDate: NOW }), NOW)).toMatchObject({
      eligible: true,
    });
  });

  it("refuses everything on a voided bill", () => {
    expect(returnEligibility(line({ saleVoided: true }), NOW)).toMatchObject({
      eligible: false,
      reason: "sale-voided",
    });
  });

  it("puts the void ahead of every other objection", () => {
    // A voided bill with an expired, already-returned line reports the void,
    // because that is the fact that explains the other two.
    expect(
      returnEligibility(
        line({ saleVoided: true, returnedQuantity: 10, expiryDate: days(-30) }),
        NOW,
      ),
    ).toMatchObject({ reason: "sale-voided" });
  });

  it("never reports returnable units on an ineligible line", () => {
    for (const over of [
      { saleVoided: true },
      { returnedQuantity: 10 },
      { expiryDate: days(-1) },
    ]) {
      expect(returnEligibility(line(over), NOW).returnable).toBe(0);
    }
  });

  it("treats an unreadable expiry as not expired rather than refusing", () => {
    // A bill line with a corrupt date should not be able to block a counter;
    // the physical check still stands behind it.
    expect(returnEligibility(line({ expiryDate: "not a date" }), NOW)).toMatchObject(
      { eligible: true },
    );
  });
});

describe("remainingUnits", () => {
  it("never goes negative when more was returned than sold", () => {
    expect(remainingUnits({ quantity: 5, returnedQuantity: 8 })).toBe(0);
  });

  it("treats a missing returnedQuantity as none returned", () => {
    expect(remainingUnits({ quantity: 5 })).toBe(5);
    expect(remainingUnits({ quantity: 5, returnedQuantity: null })).toBe(5);
  });
});

describe("isExpiredForReturn", () => {
  it("is exclusive of the expiry instant itself", () => {
    expect(isExpiredForReturn(NOW, NOW)).toBe(false);
    expect(isExpiredForReturn(days(-0.001), NOW)).toBe(true);
  });
});

describe("return reasons", () => {
  it("offers no reason that implies unsellable goods", () => {
    // Damaged and expired goods are a write-off, not a return, and must not
    // be selectable on a screen that puts stock back on the shelf.
    const codes = RETURN_REASONS.map((reason) => reason.code).join(" ");
    for (const banned of ["damage", "expired", "broken", "tampered", "opened"]) {
      expect(codes).not.toContain(banned);
    }
  });

  it("validates codes", () => {
    expect(isReturnReason("changed-mind")).toBe(true);
    for (const value of ["", "damaged", null, undefined, 3]) {
      expect(isReturnReason(value)).toBe(false);
    }
  });
});

/*
  Refund method.
  --------------
  How the money goes back is not cosmetic: "reduce what they owe" records that
  nothing left the drawer, so offering it on a settled bill would lose a real
  refund. The service re-checks this against the bill, but the screen should
  not offer an option the server is about to refuse either.
*/
describe("refundMethodsFor", () => {
  it("offers cash and original payment on a settled bill", () => {
    const codes = refundMethodsFor(0).map((method) => method.code);
    expect(codes).toEqual(["cash", "original"]);
  });

  it("does not offer a balance adjustment when nothing is owed", () => {
    expect(refundMethodsFor(0).map((m) => m.code)).not.toContain("adjust");
    expect(refundMethodsFor(-5).map((m) => m.code)).not.toContain("adjust");
  });

  it("adds the balance adjustment once something is outstanding", () => {
    const codes = refundMethodsFor(250).map((method) => method.code);
    expect(codes).toContain("adjust");
    expect(codes).toHaveLength(3);
  });

  it("offers a subset of the real methods, never an invented one", () => {
    const all = REFUND_METHODS.map((method) => method.code);
    for (const outstanding of [0, 1, 1000]) {
      for (const method of refundMethodsFor(outstanding)) {
        expect(all, method.code).toContain(method.code);
      }
    }
  });
});

describe("defaultRefundMethod", () => {
  it("clears the debt first where there is one", () => {
    // The commonest return at a counter is on a credit sale, where no money
    // ever changed hands - preselecting cash would invite handing some over.
    expect(defaultRefundMethod(250)).toBe("adjust");
  });

  it("falls back to cash on a settled bill", () => {
    expect(defaultRefundMethod(0)).toBe("cash");
  });

  it("always preselects something the same balance actually offers", () => {
    for (const outstanding of [0, 0.5, 250]) {
      const offered = refundMethodsFor(outstanding).map((m) => m.code);
      expect(offered, String(outstanding)).toContain(
        defaultRefundMethod(outstanding),
      );
    }
  });
});

describe("isRefundMethod", () => {
  it("recognises its own codes and nothing else", () => {
    for (const method of REFUND_METHODS) {
      expect(isRefundMethod(method.code), method.code).toBe(true);
    }
    // Store credit is deliberately not a method: there is no balance to hold
    // it and nothing at the till that could spend it.
    expect(isRefundMethod("store-credit")).toBe(false);
    expect(isRefundMethod("")).toBe(false);
    expect(isRefundMethod(undefined)).toBe(false);
  });

  it("gives every method a label and a hint", () => {
    for (const method of REFUND_METHODS) {
      expect(method.label.length).toBeGreaterThan(3);
      expect(method.hint.length).toBeGreaterThan(10);
    }
  });
});

describe("refundSplit", () => {
  it("hands the whole value back on a settled bill", () => {
    expect(refundSplit(1.53, 0)).toEqual({ offBalance: 0, paidOut: 1.53 });
  });

  it("clears the debt before any money goes back", () => {
    // Owed 0.76, returned 1.53: the debt goes, 0.77 is handed over.
    expect(refundSplit(1.53, 0.76)).toEqual({ offBalance: 0.76, paidOut: 0.77 });
  });

  it("hands nothing back when the return is smaller than the debt", () => {
    expect(refundSplit(100, 250)).toEqual({ offBalance: 100, paidOut: 0 });
  });
});
