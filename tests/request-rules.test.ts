import { describe, expect, it } from "vitest";
import { canSwitchBranch } from "@/lib/branch-scope";
import {
  BACKGROUND_PATHS,
  auditorMayWrite,
  browserIsIdle,
  heartbeatMs,
  idleLimitApplies,
  shouldShareActivity,
} from "@/lib/request-rules";
import { isSignedOutSession, signSession, verifySession, type SessionUser } from "@/lib/session";
import { settingsSchema } from "@/lib/validation";

const MINUTE = 60_000;
const NOW = 100 * MINUTE;

describe("browserIsIdle", () => {
  const limit = 30 * MINUTE;

  it("does not sign out a forgotten tab while another is in use", () => {
    expect(browserIsIdle(NOW, NOW - 45 * MINUTE, NOW - 2 * MINUTE, limit)).toBe(false);
  });

  it("signs out when no tab has been touched", () => {
    expect(browserIsIdle(NOW, NOW - 45 * MINUTE, NOW - 40 * MINUTE, limit)).toBe(true);
  });

  it("judges alone when storage is blocked", () => {
    expect(browserIsIdle(NOW, NOW - 45 * MINUTE, null, limit)).toBe(true);
    expect(browserIsIdle(NOW, NOW - MINUTE, null, limit)).toBe(false);
  });
});

describe("shouldShareActivity", () => {
  it("does not write to storage on every keypress", () => {
    expect(shouldShareActivity(10_000, 9_000)).toBe(false);
    expect(shouldShareActivity(15_000, 9_000)).toBe(true);
  });
});

describe("heartbeatMs", () => {
  it("is five minutes at most, and well inside a short limit", () => {
    expect(heartbeatMs(1800)).toBe(5 * MINUTE);
    expect(heartbeatMs(120)).toBe(40_000);
  });
});

describe("idleLimitApplies", () => {
  it("leaves the background alert check alone, or it would cancel its own schedule", () => {
    expect(idleLimitApplies("/api/reports/alerts")).toBe(false);
  });

  it("lets a sign-out through, so it can be recorded", () => {
    expect(idleLimitApplies("/api/auth/logout")).toBe(false);
  });

  it("applies to everything else, including other background requests", () => {
    expect(idleLimitApplies("/api/auth/me")).toBe(true);
    expect(idleLimitApplies("/api/sales")).toBe(true);
    expect(idleLimitApplies("/dashboard")).toBe(true);
  });

  it("keeps the alert check from counting as activity", () => {
    expect(BACKGROUND_PATHS).toContain("/api/reports/alerts");
  });
});

describe("auditorMayWrite", () => {
  it("allows what changes nothing on record", () => {
    for (const path of ["/api/auth/activity", "/api/reports/alerts", "/api/branches/scope", "/api/auth/logout", "/api/sales/abc/print"]) {
      expect(auditorMayWrite(path)).toBe(true);
    }
  });

  it("refuses real writes", () => {
    for (const path of ["/api/sales", "/api/sales/abc/void", "/api/settings", "/api/medicines"]) {
      expect(auditorMayWrite(path)).toBe(false);
    }
  });
});

describe("canSwitchBranch", () => {
  it("lets an auditor read every outlet, but not a cashier", () => {
    expect(canSwitchBranch({ role: "auditor" } as SessionUser)).toBe(true);
    expect(canSwitchBranch({ role: "cashier" } as SessionUser)).toBe(false);
  });
});

describe("a signed-out session", () => {
  const user = { id: "507f1f77bcf86cd799439011", name: "A", email: "a@x.np", role: "cashier" } as SessionUser;

  it("is rejected in every refreshed copy, but a new sign-in is not", async () => {
    const original = (await verifySession(await signSession(user, 1000)))!;
    const marker = String(original.expiresAt);
    expect(isSignedOutSession(original, marker)).toBe(true);

    // What a late response would put back: same session, refreshed.
    const refreshed = (await verifySession(await signSession(original, original.expiresAt! - Math.floor(Date.now() / 1000))))!;
    expect(isSignedOutSession(refreshed, marker)).toBe(true);

    const later = (await verifySession(await signSession(user, 5000)))!;
    expect(isSignedOutSession(later, marker)).toBe(false);
  });

  it("does nothing with no marker", () => {
    expect(isSignedOutSession({ expiresAt: 123 }, undefined)).toBe(false);
  });
});

describe("settings number boxes", () => {
  it("refuse a blank box rather than saving zero", () => {
    expect(settingsSchema.safeParse({ abbreviatedInvoiceLimit: "" }).success).toBe(false);
    expect(settingsSchema.safeParse({ vatRate: "  " }).success).toBe(false);
    expect(settingsSchema.safeParse({ abbreviatedInvoiceLimit: "abc" }).success).toBe(false);
  });

  it("accept typed numbers, a deliberate zero, and absence", () => {
    expect(settingsSchema.parse({ abbreviatedInvoiceLimit: "7500" }).abbreviatedInvoiceLimit).toBe(7500);
    expect(settingsSchema.parse({ vatRate: "0" }).vatRate).toBe(0);
    expect(settingsSchema.parse({}).abbreviatedInvoiceLimit).toBe(5000);
    expect(settingsSchema.parse({}).vatRate).toBe(13);
  });
});
