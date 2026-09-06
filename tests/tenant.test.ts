import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import {
  assertPharmacyOwned,
  isSuperAdmin,
  pharmacyFilter,
  pharmacyMatch,
  slugifyPharmacyName,
} from "@/lib/tenant";
import type { SessionUser } from "@/lib/session";

const PHARMACY_ID = new Types.ObjectId();

function user(role: SessionUser["role"], pharmacyId = String(PHARMACY_ID)): SessionUser {
  return {
    id: "u1",
    name: "Test",
    email: "test@example.com",
    role,
    pharmacyId: role === "superadmin" ? "" : pharmacyId,
    pharmacyName: role === "superadmin" ? "" : "Test Pharmacy",
    pharmacySlug: role === "superadmin" ? "" : "test",
    branchId: role === "superadmin" ? "" : "b1",
    branchCode: role === "superadmin" ? "" : "main",
    branchName: role === "superadmin" ? "" : "Main",
  };
}

describe("isSuperAdmin", () => {
  it("is only true for the platform role", () => {
    expect(isSuperAdmin(user("superadmin"))).toBe(true);
    expect(isSuperAdmin(user("admin"))).toBe(false);
  });
});

describe("pharmacyFilter", () => {
  it("scopes a pharmacy owner to their tenant", () => {
    expect(pharmacyFilter(user("admin"))).toEqual({ pharmacyId: PHARMACY_ID });
  });

  it("refuses the platform administrator", () => {
    expect(() => pharmacyFilter(user("superadmin"))).toThrow(ApiError);
  });
});

describe("pharmacyMatch", () => {
  it("uses the scope's pharmacy", () => {
    expect(pharmacyMatch({ pharmacyId: PHARMACY_ID })).toEqual({
      pharmacyId: PHARMACY_ID,
    });
  });

  it("matches nothing when the tenant is missing, rather than every shop", () => {
    expect(pharmacyMatch(null)).toEqual({ pharmacyId: { $in: [] } });
    expect(pharmacyMatch({ pharmacyId: null })).toEqual({ pharmacyId: { $in: [] } });
  });
});

describe("assertPharmacyOwned", () => {
  it("lets a matching document through", () => {
    expect(() => assertPharmacyOwned(PHARMACY_ID, user("admin"))).not.toThrow();
  });

  it("hides another pharmacy's document as not found", () => {
    expect(() => assertPharmacyOwned(new Types.ObjectId(), user("admin"))).toThrow(
      ApiError,
    );
  });
});

describe("slugifyPharmacyName", () => {
  it("makes a stable handle from a trading name", () => {
    expect(slugifyPharmacyName("Sagarmatha Pharmacy")).toBe("sagarmatha-pharmacy");
  });

  it("falls back when the name has no latin letters", () => {
    expect(slugifyPharmacyName("   ")).toBe("pharmacy");
  });
});
