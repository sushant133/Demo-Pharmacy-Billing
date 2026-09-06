import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  ALL_BRANCHES,
  branchFilter,
  branchMatch,
  canSwitchBranch,
  writeBranchId,
} from "@/lib/branch-scope";
import type { SessionUser } from "@/lib/session";

const HOME_ID = new Types.ObjectId();

const PHARMACY_ID = new Types.ObjectId();

function user(role: SessionUser["role"], branchId = String(HOME_ID)): SessionUser {
  return {
    id: "u1",
    name: "Test",
    email: "test@example.com",
    role,
    pharmacyId: String(PHARMACY_ID),
    pharmacyName: "Test Pharmacy",
    pharmacySlug: "test",
    branchId,
    branchCode: "main",
    branchName: "Main",
  };
}

describe("canSwitchBranch", () => {
  it("lets an admin look across outlets", () => {
    expect(canSwitchBranch(user("admin"))).toBe(true);
  });

  it("does not let the platform administrator switch a shop's outlets", () => {
    expect(canSwitchBranch(user("superadmin"))).toBe(false);
  });
});

describe("branchFilter", () => {
  it("still scopes to the pharmacy when viewing every branch", () => {
    expect(
      branchFilter({
        pharmacyId: PHARMACY_ID,
        branchId: null,
        code: null,
        label: "All branches",
        switchable: true,
      }),
    ).toEqual({ pharmacyId: PHARMACY_ID });
  });

  it("matches nothing when no scope was passed, rather than every vendor", () => {
    expect(branchFilter()).toEqual({ pharmacyId: { $in: [] } });
    expect(branchFilter(null)).toEqual({ pharmacyId: { $in: [] } });
  });

  it("scopes a query to one outlet", () => {
    const id = new Types.ObjectId();
    expect(
      branchFilter({
        pharmacyId: PHARMACY_ID,
        branchId: id,
        code: "pokhara",
        label: "Pokhara",
        switchable: false,
      }),
    ).toEqual({ pharmacyId: PHARMACY_ID, branchId: id });
  });

  it("can target a different field name", () => {
    const id = new Types.ObjectId();
    expect(
      branchFilter(
        {
          pharmacyId: PHARMACY_ID,
          branchId: id,
          code: "main",
          label: "Main",
          switchable: false,
        },
        "homeBranchId",
      ),
    ).toEqual({ pharmacyId: PHARMACY_ID, homeBranchId: id });
  });

  it("matches branchMatch", () => {
    const id = new Types.ObjectId();
    const scope = {
      pharmacyId: PHARMACY_ID,
      branchId: id,
      code: "main",
      label: "Main",
      switchable: false,
    };
    expect(branchMatch(scope)).toEqual(branchFilter(scope));
  });
});

describe("ALL_BRANCHES", () => {
  it("is the cookie value for the whole-business view", () => {
    expect(ALL_BRANCHES).toBe("all");
  });
});

describe("writeBranchId", () => {
  const pokharaId = new Types.ObjectId();

  it("uses a named viewing branch as the counter you are standing at", () => {
    expect(
      writeBranchId(user("admin"), {
        pharmacyId: PHARMACY_ID,
        branchId: pokharaId,
        code: "pokhara",
        label: "Pokhara",
        switchable: true,
      })?.toString(),
    ).toBe(String(pokharaId));
  });

  it("falls back to the user's own outlet when viewing all branches", () => {
    expect(
      writeBranchId(user("admin"), {
        pharmacyId: PHARMACY_ID,
        branchId: null,
        code: null,
        label: "All branches",
        switchable: true,
      })?.toString(),
    ).toBe(String(HOME_ID));
  });

  it("returns null when an unassigned admin is viewing all branches", () => {
    const unassigned = { ...user("admin"), branchId: "" };
    expect(
      writeBranchId(unassigned, {
        pharmacyId: PHARMACY_ID,
        branchId: null,
        code: null,
        label: "All branches",
        switchable: true,
      }),
    ).toBeNull();
  });

  it("pins a sale to the outlet being viewed, not the whole business", () => {
    const ownId = new Types.ObjectId();
    expect(
      writeBranchId(user("admin"), {
        pharmacyId: PHARMACY_ID,
        branchId: ownId,
        code: "main",
        label: "Main",
        switchable: false,
      })?.toString(),
    ).toBe(String(ownId));
  });
});
