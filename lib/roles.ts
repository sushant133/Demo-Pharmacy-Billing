/**
 * Roles and permissions.
 *
 * Kept free of Node-only imports so that middleware (Edge runtime), server
 * components and client components can all share one source of truth.
 */

export const ROLES = [
  "superadmin",
  "admin",
  "manager",
  "pharmacist",
  "cashier",
  "inventory",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * The roles a pharmacy owner may hand out, in descending order of reach.
 *
 * `superadmin` is absent on purpose: it runs the platform and creates
 * pharmacies, and no shop should be able to mint one from its own staff
 * screen.
 */
export const ASSIGNABLE_ROLES = [
  "admin",
  "manager",
  "pharmacist",
  "cashier",
  "inventory",
] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}

/**
 * The role scheme an account or session cookie was written under.
 *
 * Scheme 1 had `pharmacist` and `cashier` as *aliases for the owner* - they
 * were folded into `admin`, and anything still carrying those words was read
 * as an admin so nobody was locked out mid-shift.
 *
 * Scheme 2 brings those two words back as genuinely narrower roles. The words
 * are identical, so the string alone can no longer say which is meant, and
 * guessing would silently strip a working owner of the screens they use all
 * day. The version is therefore recorded explicitly: rows and tokens written
 * from now on say 2, and anything without it is read under the old meaning.
 */
export const ROLE_SCHEME_VERSION = 2;

/** Roles that meant "the owner" under scheme 1. */
const SCHEME_1_OWNER_ALIASES = ["pharmacist", "cashier"] as const;

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
  /** Reduce the price of a bill at the counter. */
  "sale:discount",
  /** Let a bill leave the counter without being paid in full. */
  "sale:credit",
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
 * Every shop role can open the dashboard.
 *
 * This is load-bearing, not a courtesy. `requirePagePermission` bounces a
 * refused page to /dashboard, and middleware gates /dashboard on
 * `report:read` - so a shop role without it would be redirected to a screen
 * that redirects it again. The money figures on that dashboard are gated
 * separately on `report:financial`, which is what actually keeps margins off
 * a cashier's screen.
 */
const DASHBOARD: readonly Permission[] = ["report:read"];

/**
 * Role capabilities.
 *
 * `superadmin` runs the platform: creating pharmacy accounts and suspending
 * them. It has no till, no catalogue and no other shop's books.
 *
 * The five shop roles below are one shop's staff. They are cumulative in
 * reach but not strictly nested - an inventory clerk receives goods a cashier
 * never touches, and a cashier takes money a clerk never handles - so each is
 * listed in full rather than derived from the one above it.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  superadmin: ["pharmacy:manage"],

  /** The pharmacy owner. Everything in their own shop, no other shop. */
  admin: SHOP_PERMISSIONS,

  /**
   * Runs the shop day to day and answers for its figures, but does not decide
   * who works there, what the outlets are, or what the shop calls itself.
   */
  manager: SHOP_PERMISSIONS.filter(
    (permission) =>
      permission !== "user:manage" &&
      permission !== "branch:manage" &&
      permission !== "settings:manage",
  ),

  /**
   * Dispenses. Owns the catalogue and the professional judgement around it:
   * whether a returned medicine may go back on the shelf is a pharmacist's
   * call, so `sale:void` is here. Margins are not - reading the shop's
   * profitability is the owner's business, not a condition of dispensing.
   */
  pharmacist: [
    ...DASHBOARD,
    "medicine:read",
    "medicine:write",
    "batch:read",
    "sale:read",
    "sale:create",
    "sale:void",
    "sale:discount",
    "customer:read",
    "customer:write",
  ],

  /**
   * Bills and takes money. Deliberately cannot void a bill, discount one, or
   * let one leave unpaid: those are the three ways a till loses money quietly,
   * and each should cost somebody a word with the person in charge.
   */
  cashier: [
    ...DASHBOARD,
    "medicine:read",
    "batch:read",
    "sale:read",
    "sale:create",
    "customer:read",
    "customer:write",
    "payment:write",
  ],

  /**
   * Receives, counts and moves stock. No till and no customers; the counter
   * is not their job. `purchase:cancel` is withheld - unposting a delivery
   * rewrites stock history and belongs with whoever owns the books.
   */
  inventory: [
    ...DASHBOARD,
    "medicine:read",
    "medicine:write",
    "batch:read",
    "batch:write",
    "supplier:read",
    "purchase:read",
    "purchase:write",
    "purchase:post",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Every permission a role holds. Used by the roles matrix screen. */
export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
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
 * Read a role off an account row or a session token.
 *
 * `scheme` is the role-scheme version stored beside the role - `roleVersion`
 * on a user document, the `rv` claim on a session cookie. Absent means the
 * value was written before narrower roles existed, when `pharmacist` and
 * `cashier` were simply other words for the owner; those are still read as
 * admin, so neither an unmigrated row nor a cookie signed last week loses
 * access. From scheme 2 on, the word means exactly what it says.
 *
 * Anything else is not a role we ever issued, and returns null so the caller
 * can refuse it.
 */
export function normalizeRole(value: unknown, scheme?: unknown): Role | null {
  const version = typeof scheme === "number" ? scheme : 1;

  if (
    version < 2 &&
    typeof value === "string" &&
    (SCHEME_1_OWNER_ALIASES as readonly string[]).includes(value)
  ) {
    return "admin";
  }

  return isRole(value) ? value : null;
}

/**
 * The role a stored account row resolves to, as something assignable.
 *
 * The single reader for `{ role, roleVersion }` off a user document - the
 * staff library, the staff register and the status screen all go through it,
 * so a row cannot be read as an owner in one place and a cashier in another.
 *
 * Falls back to the *most restricted* role rather than the widest. A row this
 * cannot read is a row we know nothing about, and guessing upward would turn
 * a corrupt value into a login that can void bills.
 */
export function assignableRoleOf(doc: {
  role?: unknown;
  roleVersion?: unknown;
}): AssignableRole {
  const role = normalizeRole(doc.role, doc.roleVersion);
  return role && isAssignableRole(role) ? role : "cashier";
}

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "Super administrator",
  admin: "Pharmacy owner",
  manager: "Pharmacy manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory: "Inventory staff",
};

/** One line on what the role is for, shown wherever one is picked. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  superadmin: "Creates and suspends pharmacies. Works in no shop.",
  admin: "Full control of this pharmacy, including staff, settings and figures.",
  manager:
    "Runs the shop and reads its figures. Cannot issue logins or change settings.",
  pharmacist:
    "Dispenses, bills and keeps the catalogue. Cannot see margins or buy stock.",
  cashier: "Bills and takes payment. Cannot void, discount, or sell on credit.",
  inventory:
    "Receives and counts stock. No till, no customers, no money figures.",
};

/** Which top-level screens a role may open. Used by the nav and middleware. */
export const ROUTE_PERMISSIONS: Array<{ prefix: string; permission: Permission }> = [
  { prefix: "/superadmin", permission: "pharmacy:manage" },
  { prefix: "/billing", permission: "sale:create" },
  { prefix: "/sales", permission: "sale:read" },
  { prefix: "/invoices", permission: "sale:read" },
  { prefix: "/prescriptions", permission: "sale:read" },
  { prefix: "/medicines", permission: "medicine:read" },
  { prefix: "/batches", permission: "batch:read" },
  { prefix: "/inventory", permission: "batch:read" },
  { prefix: "/customers", permission: "customer:read" },
  { prefix: "/suppliers", permission: "supplier:read" },
  { prefix: "/purchases", permission: "purchase:read" },
  { prefix: "/reports", permission: "report:financial" },
  { prefix: "/expenses", permission: "report:financial" },
  { prefix: "/payments", permission: "payment:write" },
  { prefix: "/payables", permission: "payment:write" },
  { prefix: "/receivables", permission: "payment:write" },
  { prefix: "/alerts", permission: "report:read" },
  { prefix: "/dashboard", permission: "report:read" },
  { prefix: "/staff", permission: "user:manage" },
  { prefix: "/branches", permission: "branch:manage" },
  { prefix: "/settings", permission: "settings:manage" },
];
