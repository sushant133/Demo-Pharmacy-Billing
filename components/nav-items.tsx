import type { ReactNode } from "react";
import type { Permission } from "@/lib/roles";

/**
 * The pharmacy sidebar, as data.
 *
 * Kept out of AppShell so the shape of the menu can be read in one screenful
 * and changed without touching the drawer, the prefetch warming or the
 * highlight bookkeeping around it.
 *
 * This is the menu of a *single, already-created* pharmacy. Nothing here
 * creates or switches pharmacies - that lives in the separate superadmin
 * shell, and the two must not grow into each other.
 *
 * One destination, one row. Batches and the expiry view each used to appear
 * twice - once as a top-level row and again inside Inventory - which made the
 * menu longer without making anything reachable that was not already, and left
 * the highlight ambiguous when one of the pair was open. Neither is listed
 * here now: the batch register is reached from Inventory and from a medicine's
 * own row, and expiry is what the Alerts screen is for.
 *
 * Money is grouped by question rather than by direction: Receivables and
 * Payables sit together because "where does the shop stand" is one question
 * with two halves. Settings is under Management rather than Finance - it is
 * how the shop is configured, not a figure anybody reconciles.
 *
 * Rows are filtered by permission, so what a cashier sees is a much shorter
 * menu than an owner's. A row nobody's role allows simply is not rendered.
 */

export interface NavChild {
  href: string;
  label: string;
  permission: Permission;
}

export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  icon: ReactNode;
  /** Keyboard shortcut shown on the right of the row. */
  hint?: string;
  /** Shows the pending-alert count when there is one. */
  badge?: "alerts";
  /** Rows that only exist while the parent is expanded. */
  children?: NavChild[];
}

export interface NavSection {
  /** Uppercase group heading. Null for the ungrouped rows at the top. */
  title: string | null;
  items: NavItem[];
}

const icon = (path: string) => (
  <svg
    className="h-5 w-5 shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.7}
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d={path} />
  </svg>
);

export const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        permission: "report:read",
        icon: icon("M3 12l9-9 9 9M5 10v10h14V10"),
      },
    ],
  },
  {
    title: "Sales",
    items: [
      {
        href: "/billing",
        label: "New Sale",
        permission: "sale:create",
        hint: "F2",
        icon: icon(
          "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2 5h14M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z",
        ),
      },
      {
        href: "/sales",
        label: "Sales",
        permission: "sale:read",
        icon: icon("M9 17V9m4 8V5m4 12v-6M4 20h16"),
      },
      {
        href: "/sales/returns",
        label: "Returns",
        permission: "sale:void",
        icon: icon("M3 10h10a4 4 0 010 8H9m-6-4l3-3m-3 3l3 3"),
      },
      {
        href: "/invoices",
        label: "Invoices",
        permission: "sale:read",
        icon: icon(
          "M7 21h10a2 2 0 002-2V8.4L12.6 3H7a2 2 0 00-2 2v14a2 2 0 002 2zM9 12h6m-6 4h4",
        ),
      },
    ],
  },
  {
    title: "Pharmacy",
    items: [
      {
        href: "/medicines",
        label: "Medicines",
        permission: "medicine:read",
        icon: icon("M10.5 20.5a4.95 4.95 0 01-7-7l6-6a4.95 4.95 0 017 7l-6 6zM7 11l6 6"),
      },
      {
        href: "/inventory",
        label: "Inventory",
        permission: "batch:read",
        icon: icon("M4 7h16M4 12h16M4 17h16M8 4v3m8-3v3M8 14v3m8-3v3"),
        children: [
          { href: "/inventory", label: "Current stock", permission: "batch:read" },
          { href: "/inventory/stock-in", label: "Stock in", permission: "batch:write" },
          { href: "/inventory/stock-out", label: "Stock out", permission: "batch:write" },
          {
            href: "/inventory/adjustments",
            label: "Stock adjustment",
            permission: "batch:write",
          },
          {
            href: "/inventory/transfers",
            label: "Stock transfer",
            permission: "batch:write",
          },
          {
            href: "/inventory/damaged",
            label: "Damaged / expired stock",
            permission: "batch:write",
          },
        ],
      },
      {
        href: "/prescriptions",
        label: "Prescriptions",
        permission: "sale:read",
        icon: icon("M6 3h6l6 6v12H6V3zm0 6h6V3M9 13h6m-6 4h4"),
      },
      {
        href: "/customers",
        label: "Customers / Patients",
        permission: "customer:read",
        icon: icon(
          "M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20M9.5 10.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1.5a4 4 0 00-3-3.87M16.5 3.6a4 4 0 010 7.75",
        ),
      },
    ],
  },
  {
    title: "Purchases",
    items: [
      {
        href: "/purchases",
        label: "Purchases",
        permission: "purchase:read",
        icon: icon(
          "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.6L19 8.4V19a2 2 0 01-2 2z",
        ),
      },
      {
        href: "/suppliers",
        label: "Suppliers",
        permission: "supplier:read",
        icon: icon("M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5"),
      },
      {
        // Goods going back out. Sits under Purchases rather than beside the
        // customer Returns row: the paperwork, the counterparty and the person
        // doing it are the supplier's, not the counter's.
        href: "/purchases/returns",
        label: "Purchase Returns",
        permission: "purchase:read",
        icon: icon("M4 4v6h6M4 10a8 8 0 1 1 2 5.3M12 8v4l3 2"),
      },
    ],
  },
  {
    title: "Finance",
    items: [
      {
        // Money in, opposite /payables. Named for the ledger rather than the
        // act, because "who owes us" is the question people arrive with.
        href: "/receivables",
        label: "Receivables",
        permission: "payment:write",
        icon: icon(
          "M12 3v18m4-14.2c-.9-1-2.5-1.6-4.5-1.6-2.8 0-4.5 1.2-4.5 3s1.7 2.7 4.5 3.2 4.5 1.4 4.5 3.2-1.7 3-4.5 3c-2 0-3.6-.6-4.5-1.6",
        ),
      },
      {
        href: "/payments",
        label: "Payments",
        permission: "payment:write",
        icon: icon("M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm2 8h4"),
      },
      {
        // The creditors' mirror of Receivables. Sits next to it so the two
        // halves of "where does the shop stand" are read together.
        href: "/payables",
        label: "Payables",
        permission: "payment:write",
        icon: icon("M12 21V3m-4 14.2c.9 1 2.5 1.6 4.5 1.6M4 8h6M4 12h4"),
      },
      {
        // Money out that is not stock. Sits with the other money screens
        // rather than under Management: an owner reconciling the month reads
        // receivables, payables and expenses together.
        href: "/expenses",
        label: "Expenses",
        permission: "report:financial",
        icon: icon(
          "M4 7h16M4 12h10M4 17h7M20 14v6m3-3h-6",
        ),
      },
      {
        href: "/reports",
        label: "Reports",
        permission: "report:financial",
        icon: icon("M9 17V9m4 8V5m4 12v-6M4 4v16h16"),
      },
    ],
  },
  {
    title: "Management",
    items: [
      {
        href: "/alerts",
        label: "Alerts",
        permission: "report:read",
        badge: "alerts",
        icon: icon(
          "M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
        ),
      },
      {
        href: "/staff",
        label: "Staff & Users",
        permission: "user:manage",
        icon: icon(
          "M17 20h5v-1.5a3.5 3.5 0 00-5-3.16M2 20h12v-1.5a4 4 0 00-4-4H6a4 4 0 00-4 4V20zM8 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm9 0a3 3 0 100-6 3 3 0 000 6z",
        ),
        children: [
          { href: "/staff", label: "Staff members", permission: "user:manage" },
          { href: "/staff?new=1", label: "Add staff", permission: "user:manage" },
          { href: "/staff/roles", label: "Roles & permissions", permission: "user:manage" },
          { href: "/staff/status", label: "User status", permission: "user:manage" },
          { href: "/staff/activity", label: "Activity history", permission: "user:manage" },
        ],
      },
      {
        href: "/branches",
        label: "Branches",
        permission: "branch:manage",
        icon: icon("M8 21V9l4-4 4 4v12M3 21h18M10 13h4"),
      },
      {
        // Moved out of Finance: this is how the shop is configured, not a
        // figure anyone reconciles. It belongs with staff and branches.
        href: "/settings",
        label: "Settings",
        permission: "settings:manage",
        icon: icon(
          "M10.3 4.3a1.9 1.9 0 013.4 0l.4.8a1.9 1.9 0 002.2.9l.9-.2a1.9 1.9 0 012.3 2.3l-.2.9a1.9 1.9 0 00.9 2.2l.8.4a1.9 1.9 0 010 3.4l-.8.4a1.9 1.9 0 00-.9 2.2l.2.9a1.9 1.9 0 01-2.3 2.3l-.9-.2a1.9 1.9 0 00-2.2.9l-.4.8a1.9 1.9 0 01-3.4 0l-.4-.8a1.9 1.9 0 00-2.2-.9l-.9.2a1.9 1.9 0 01-2.3-2.3l.2-.9a1.9 1.9 0 00-.9-2.2l-.8-.4a1.9 1.9 0 010-3.4l.8-.4a1.9 1.9 0 00.9-2.2l-.2-.9a1.9 1.9 0 012.3-2.3l.9.2a1.9 1.9 0 002.2-.9l.4-.8zM12 15a3 3 0 100-6 3 3 0 000 6z",
        ),
      },
    ],
  },
];
