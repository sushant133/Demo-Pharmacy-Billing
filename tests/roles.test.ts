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
  it("is the single counter role", () => {
    expect(ROLES).toEqual(["admin"]);
  });

  it("does not recognise the roles that were folded into it", () => {
    expect(isRole("pharmacist")).toBe(false);
    expect(isRole("cashier")).toBe(false);
    expect(isRole("admin")).toBe(true);
  });
});

describe("admin", () => {
  it("can do every job in the shop, including billing and dispensing", () => {
    for (const permission of PERMISSIONS) {
      expect(can("admin", permission), permission).toBe(true);
    }
  });

  it("opens on the till", () => {
    expect(homePath("admin")).toBe("/billing");
  });
});

describe("normalizeRole", () => {
  it("reads an account or cookie left on an old role as admin", () => {
    expect(normalizeRole("pharmacist")).toBe("admin");
    expect(normalizeRole("cashier")).toBe("admin");
  });

  it("passes admin straight through", () => {
    expect(normalizeRole("admin")).toBe("admin");
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
    ];
    for (const permission of needed) {
      expect(PERMISSIONS).toContain(permission);
      expect(can("admin", permission)).toBe(true);
    }
  });
});
