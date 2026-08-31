/**
 * Roles and permissions.
 *
 * Kept free of Node-only imports so that middleware (Edge runtime), server
 * components and client components can all share one source of truth.
 */

export const ROLES = ["admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles this system used to have, kept only so old accounts and old session
 * cookies can be read. Nothing new is ever written with these.
 */
const LEGACY_ROLES = ["pharmacist", "cashier"] as const;

export const PERMISSIONS = [
  "medicine:read",
  "medicine:write",
  "medicine:delete",
  "batch:read",
  "batch:write",
  "batch:delete",
  "sale:read",
  "sale:create",
  "sale:void",
  "customer:read",
  "customer:write",
  "report:read",
  "report:financial",
  "report:export",
  "supplier:read",
  "supplier:write",
  "supplier:delete",
  "purchase:read",
  "purchase:write",
  "purchase:post",
  "purchase:cancel",
  "payment:write",
  "user:manage",
  "branch:manage",
  "settings:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role capabilities.
 *
 * There is one role, and it holds everything. A shop this size is run from one
 * counter: the same person bills, dispenses, receives the stock and reads the
 * month's figures. Splitting that person into a "pharmacist" who could not open
 * the branch screen and a "cashier" who could not see a margin only ever got in
 * their way.
 *
 * The permission list and the `can()` guard on every route are deliberately
 * kept. They are what would make a second role a single entry in the table
 * below, rather than a rewrite of every handler, if the shop ever grows enough
 * to want one.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Where a signed-in user lands. Anyone who can sell opens on the till. */
export function homePath(role: Role): string {
  return can(role, "sale:create") ? "/billing" : "/dashboard";
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Read a role off an account or a session token.
 *
 * Accounts created before the pharmacist and cashier roles were folded into
 * admin still carry those words, and so do session cookies signed before the
 * change. Locking a real user out of their own shop over a stale string would
 * be the wrong answer, so those are read as admin - which is what
 * `npm run migrate:roles` writes to the account itself. Anything else is not a
 * role we ever issued, and returns null so the caller can refuse it.
 */
export function normalizeRole(value: unknown): Role | null {
  if (isRole(value)) return value;
  if (
    typeof value === "string" &&
    (LEGACY_ROLES as readonly string[]).includes(value)
  ) {
    return "admin";
  }
  return null;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
};

/** Which top-level screens a role may open. Used by the nav and middleware. */
export const ROUTE_PERMISSIONS: Array<{ prefix: string; permission: Permission }> = [
  { prefix: "/billing", permission: "sale:create" },
  { prefix: "/sales", permission: "sale:read" },
  { prefix: "/medicines", permission: "medicine:read" },
  { prefix: "/batches", permission: "batch:read" },
  { prefix: "/suppliers", permission: "supplier:read" },
  { prefix: "/purchases", permission: "purchase:read" },
  { prefix: "/reports", permission: "report:financial" },
  { prefix: "/alerts", permission: "report:read" },
  { prefix: "/dashboard", permission: "report:read" },
  { prefix: "/branches", permission: "branch:manage" },
  { prefix: "/settings", permission: "settings:manage" },
];
