import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  can,
  homePath,
  isRole,
  normalizeRole,
  type Permission,
} from "@/lib/roles";

describe("ROLES", () => {
  it("is the platform operator and the pharmacy owner", () => {
    expect(ROLES).toEqual(["superadmin", "admin"]);
  });

  it("does not recognise the roles that were folded into admin", () => {
    expect(isRole("pharmacist")).toBe(false);
    expect(isRole("cashier")).toBe(false);
    expect(isRole("admin")).toBe(true);
    expect(isRole("superadmin")).toBe(true);
  });
});

describe("admin", () => {
  it("can do every job in the shop, but cannot create other pharmacies", () => {
    for (const permission of PERMISSIONS) {
      if (permission === "pharmacy:manage") {
        expect(can("admin", permission), permission).toBe(false);
      } else {
        expect(can("admin", permission), permission).toBe(true);
      }
    }
  });

  it("opens on the till", () => {
    expect(homePath("admin")).toBe("/billing");
  });
});

describe("superadmin", () => {
  it("can only manage pharmacies", () => {
    expect(can("superadmin", "pharmacy:manage")).toBe(true);
    expect(can("superadmin", "sale:create")).toBe(false);
    expect(can("superadmin", "medicine:read")).toBe(false);
    expect(can("superadmin", "report:financial")).toBe(false);
  });

  it("opens on the platform panel", () => {
    expect(homePath("superadmin")).toBe("/superadmin");
  });
});

describe("normalizeRole", () => {
  it("reads an account or cookie left on an old role as admin", () => {
    expect(normalizeRole("pharmacist")).toBe("admin");
    expect(normalizeRole("cashier")).toBe("admin");
  });

  it("passes admin and superadmin straight through", () => {
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("superadmin")).toBe("superadmin");
  });

  it("refuses anything that was never a role", () => {
    expect(normalizeRole("owner")).toBeNull();
    expect(normalizeRole("")).toBeNull();
    expect(normalizeRole(undefined)).toBeNull();
    expect(normalizeRole(null)).toBeNull();
    expect(normalizeRole(7)).toBeNull();
  });
});

describe("PERMISSIONS", () => {
  it("covers billing, dispensing and the rest of the counter", () => {
    const needed: Permission[] = [
      "sale:create",
      "sale:void",
      "sale:read",
      "medicine:write",
      "batch:write",
      "purchase:write",
      "purchase:post",
      "payment:write",
      "report:financial",
      "branch:manage",
      "user:manage",
      "pharmacy:manage",
    ];
    for (const permission of needed) {
      expect(PERMISSIONS).toContain(permission);
    }
  });
});
