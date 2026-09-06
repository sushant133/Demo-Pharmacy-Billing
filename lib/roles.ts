/**
 * Roles and permissions.
 *
 * Kept free of Node-only imports so that middleware (Edge runtime), server
 * components and client components can all share one source of truth.
 */

export const ROLES = ["superadmin", "admin"] as const;
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
  "pharmacy:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const SHOP_PERMISSIONS = PERMISSIONS.filter(
  (permission) => permission !== "pharmacy:manage",
);

/**
 * Role capabilities.
 *
 * `superadmin` runs the platform: creating pharmacy accounts and suspending
 * them. It has no till, no catalogue and no other shop's books.
 *
 * `admin` is the pharmacy owner. One person at a counter bills, dispenses,
 * receives stock and reads the month's figures, all inside their own
 * pharmacy. They cannot create other pharmacies.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  superadmin: ["pharmacy:manage"],
  admin: SHOP_PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Where a signed-in user lands. */
export function homePath(role: Role): string {
  if (role === "superadmin") return "/superadmin";
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
 * be the wrong answer, so those are read as admin. Anything else is not a
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
  superadmin: "Super administrator",
  admin: "Pharmacy owner",
};

/** Which top-level screens a role may open. Used by the nav and middleware. */
export const ROUTE_PERMISSIONS: Array<{ prefix: string; permission: Permission }> = [
  { prefix: "/superadmin", permission: "pharmacy:manage" },
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
