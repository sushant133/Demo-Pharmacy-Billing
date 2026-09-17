import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_SCHEME_VERSION,
  ROUTE_PERMISSIONS,
  assignableRoleOf,
  can,
  homePath,
  isAssignableRole,
  isRole,
  normalizeRole,
  permissionsFor,
  type Permission,
  type Role,
} from "@/lib/roles";

describe("ROLES", () => {
  it("is the platform operator and the five shop roles", () => {
    expect(ROLES).toEqual([
      "superadmin",
      "admin",
      "manager",
      "pharmacist",
      "cashier",
      "inventory",
    ]);
  });

  it("never offers superadmin as something a pharmacy can assign", () => {
    expect(ASSIGNABLE_ROLES).not.toContain("superadmin");
    expect(isAssignableRole("superadmin")).toBe(false);
  });

  it("can assign every shop role", () => {
    for (const role of ROLES) {
      if (role === "superadmin") continue;
      expect(isAssignableRole(role), role).toBe(true);
    }
  });

  it("gives every role a label and a description", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role], role).toBeTruthy();
    }
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

describe("manager", () => {
  it("runs the shop and reads its figures", () => {
    expect(can("manager", "sale:void")).toBe(true);
    expect(can("manager", "sale:credit")).toBe(true);
    expect(can("manager", "purchase:post")).toBe(true);
    expect(can("manager", "report:financial")).toBe(true);
  });

  it("cannot issue logins, add outlets or change the shop's settings", () => {
    expect(can("manager", "user:manage")).toBe(false);
    expect(can("manager", "branch:manage")).toBe(false);
    expect(can("manager", "settings:manage")).toBe(false);
  });
});

describe("pharmacist", () => {
  it("dispenses, bills and keeps the catalogue", () => {
    expect(can("pharmacist", "sale:create")).toBe(true);
    expect(can("pharmacist", "medicine:write")).toBe(true);
    expect(can("pharmacist", "batch:read")).toBe(true);
    // Whether a returned medicine may go back on the shelf is their call.
    expect(can("pharmacist", "sale:void")).toBe(true);
  });

  it("does not see margins, buy stock or receive it", () => {
    expect(can("pharmacist", "report:financial")).toBe(false);
    expect(can("pharmacist", "purchase:write")).toBe(false);
    expect(can("pharmacist", "batch:write")).toBe(false);
  });
});

describe("cashier", () => {
  it("can bill and take payment", () => {
    expect(can("cashier", "sale:create")).toBe(true);
    expect(can("cashier", "sale:read")).toBe(true);
    expect(can("cashier", "payment:write")).toBe(true);
    // Has to be able to find the medicine and see what is on the shelf.
    expect(can("cashier", "medicine:read")).toBe(true);
    expect(can("cashier", "batch:read")).toBe(true);
  });

  it("cannot lose money quietly", () => {
    expect(can("cashier", "sale:void")).toBe(false);
    expect(can("cashier", "sale:discount")).toBe(false);
    expect(can("cashier", "sale:credit")).toBe(false);
  });

  it("cannot see the shop's margins", () => {
    expect(can("cashier", "report:financial")).toBe(false);
  });
});

describe("inventory", () => {
  it("receives and counts stock", () => {
    expect(can("inventory", "batch:write")).toBe(true);
    expect(can("inventory", "purchase:write")).toBe(true);
    expect(can("inventory", "purchase:post")).toBe(true);
    expect(can("inventory", "supplier:read")).toBe(true);
  });

  it("has no till, no customers and no money figures", () => {
    expect(can("inventory", "sale:create")).toBe(false);
    expect(can("inventory", "customer:read")).toBe(false);
    expect(can("inventory", "payment:write")).toBe(false);
    expect(can("inventory", "report:financial")).toBe(false);
  });

  it("cannot unpost a delivery", () => {
    expect(can("inventory", "purchase:cancel")).toBe(false);
  });

  it("lands on the dashboard rather than the till", () => {
    expect(homePath("inventory")).toBe("/dashboard");
  });
});

/*
  The redirect-loop guard.

  `requirePagePermission` bounces a refused page to /dashboard, and middleware
  gates /dashboard on report:read. A shop role without it would be redirected
  to a screen that redirects it again, so this is a hard invariant rather than
  a preference about what people should see.
*/
describe("every shop role can open the screen it gets bounced to", () => {
  const dashboardRule = ROUTE_PERMISSIONS.find(
    (entry) => entry.prefix === "/dashboard",
  );

  it("has a rule for /dashboard", () => {
    expect(dashboardRule).toBeDefined();
  });

  for (const role of ASSIGNABLE_ROLES) {
    it(`${role} can open /dashboard`, () => {
      expect(can(role, dashboardRule!.permission)).toBe(true);
    });
  }

  for (const role of ASSIGNABLE_ROLES) {
    it(`${role} can open wherever homePath sends it`, () => {
      const home = homePath(role);
      const rule = ROUTE_PERMISSIONS.find((entry) => home.startsWith(entry.prefix));
      if (rule) expect(can(role, rule.permission), `${role} -> ${home}`).toBe(true);
    });
  }
});

describe("permissionsFor", () => {
  it("never grants a shop role the platform permission", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(permissionsFor(role), role).not.toContain("pharmacy:manage");
    }
  });

  it("only ever lists real permissions", () => {
    for (const role of ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(PERMISSIONS, `${role}:${permission}`).toContain(permission);
      }
    }
  });

  it("gives no shop role more than the owner", () => {
    for (const role of ASSIGNABLE_ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(can("admin", permission), `${role} has ${permission}`).toBe(true);
      }
    }
  });
});

describe("normalizeRole", () => {
  it("reads a scheme 1 pharmacist or cashier as the owner it meant", () => {
    expect(normalizeRole("pharmacist")).toBe("admin");
    expect(normalizeRole("cashier")).toBe("admin");
    expect(normalizeRole("pharmacist", 1)).toBe("admin");
    expect(normalizeRole("cashier", 1)).toBe("admin");
  });

  it("reads a scheme 2 pharmacist or cashier literally", () => {
    expect(normalizeRole("pharmacist", ROLE_SCHEME_VERSION)).toBe("pharmacist");
    expect(normalizeRole("cashier", ROLE_SCHEME_VERSION)).toBe("cashier");
  });

  it("treats a missing or unusable scheme as scheme 1", () => {
    // The whole safety property: an unreadable version must not be taken as
    // the new scheme, or a stored "cashier" silently demotes a working owner.
    expect(normalizeRole("cashier", undefined)).toBe("admin");
    expect(normalizeRole("cashier", null)).toBe("admin");
    expect(normalizeRole("cashier", "2")).toBe("admin");
  });

  it("passes the roles that mean the same under both schemes straight through", () => {
    for (const role of ["admin", "superadmin", "manager", "inventory"] as Role[]) {
      expect(normalizeRole(role), role).toBe(role);
      expect(normalizeRole(role, ROLE_SCHEME_VERSION), role).toBe(role);
    }
  });

  it("refuses anything that was never a role", () => {
    expect(normalizeRole("owner")).toBeNull();
    expect(normalizeRole("")).toBeNull();
    expect(normalizeRole(undefined)).toBeNull();
    expect(normalizeRole(null)).toBeNull();
    expect(normalizeRole(7)).toBeNull();
    expect(normalizeRole("owner", ROLE_SCHEME_VERSION)).toBeNull();
  });
});

describe("assignableRoleOf", () => {
  it("reads an unmigrated row under its old meaning", () => {
    expect(assignableRoleOf({ role: "cashier" })).toBe("admin");
    expect(assignableRoleOf({ role: "pharmacist" })).toBe("admin");
  });

  it("reads a row written since narrower roles existed literally", () => {
    expect(
      assignableRoleOf({ role: "cashier", roleVersion: ROLE_SCHEME_VERSION }),
    ).toBe("cashier");
  });

  it("falls back to the most restricted role, never the widest", () => {
    // A row nobody can read must not become a login that can void bills.
    expect(assignableRoleOf({})).toBe("cashier");
    expect(assignableRoleOf({ role: "wizard" })).toBe("cashier");
    expect(assignableRoleOf({ role: "superadmin" })).toBe("cashier");
  });
});

describe("isRole", () => {
  it("accepts every issued role and nothing else", () => {
    for (const role of ROLES) expect(isRole(role), role).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole(undefined)).toBe(false);
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
