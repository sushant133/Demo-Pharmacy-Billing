import { describe, expect, it } from "vitest";
import {
  LOCK_MINUTES,
  MAX_FAILURES,
  afterFailure,
  allowIpAttempt,
  isLocked,
} from "@/lib/login-throttle";
import { normalizeNepalPhone } from "@/lib/validation";
import { displayPaymentStatus, purchaseOutstanding } from "@/lib/purchase-math";

describe("login throttling", () => {
  it("locks the account on the last allowed failure", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    let count = 0;
    for (let i = 1; i < MAX_FAILURES; i += 1) {
      const next = afterFailure(count, now);
      expect(next.lockedUntil).toBeNull();
      count = next.failedLoginCount;
    }
    const locked = afterFailure(count, now);
    expect(locked.lockedUntil?.getTime()).toBe(now.getTime() + LOCK_MINUTES * 60000);
    expect(isLocked(locked.lockedUntil, now)).toBe(true);
    expect(isLocked(locked.lockedUntil, new Date(now.getTime() + LOCK_MINUTES * 60000 + 1))).toBe(false);
  });

  it("caps attempts per IP", () => {
    const ip = "203.0.113.9";
    const start = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 50; i += 1) if (allowIpAttempt(ip, start + i)) allowed += 1;
    expect(allowed).toBe(30);
    // The window slides: ten minutes on, the address may try again.
    expect(allowIpAttempt(ip, start + 11 * 60 * 1000)).toBe(true);
  });
});

describe("normalizeNepalPhone", () => {
  it("stores every format as ten digits", () => {
    expect(normalizeNepalPhone("+977 984-1234567")).toBe("9841234567");
    expect(normalizeNepalPhone("9779841234567")).toBe("9841234567");
    expect(normalizeNepalPhone("00977 9841234567")).toBe("9841234567");
    expect(normalizeNepalPhone("9841234567")).toBe("9841234567");
    expect(normalizeNepalPhone("")).toBe("");
  });
});

describe("purchase payment display", () => {
  it("derives the state from the money, net of returns", () => {
    expect(displayPaymentStatus({ totalAmount: 0, amountPaid: 0 })).toBe("paid");
    expect(displayPaymentStatus({ totalAmount: 1000, amountPaid: 200 })).toBe("partial");
    expect(displayPaymentStatus({ totalAmount: 1000, returnedTotal: 800, amountPaid: 200 })).toBe("paid");
    expect(purchaseOutstanding({ totalAmount: 4260, returnedTotal: 200, amountPaid: 0 })).toBe(4060);
  });
});
