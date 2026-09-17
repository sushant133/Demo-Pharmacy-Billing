import type { ModuleTab } from "@/components/ModuleScaffold";

/**
 * The inventory sub-navigation, shared by the hub and every movement screen
 * so the strip never disagrees with the sidebar.
 *
 * These are the six screens that *are* inventory, and nothing else. Batches
 * and expiry tracking used to sit on the end, which made the strip a mix of
 * "where you can go inside this module" and "two other modules" - and it
 * disagreed with the sidebar, where neither is an Inventory child any more.
 *
 * Both are still one click away from where they are actually wanted: the lot
 * register from Browse lots on the hub and View lots on any medicine row,
 * expiry from the Alerts screen that grades it.
 */
export const INVENTORY_TABS: ModuleTab[] = [
  { href: "/inventory", label: "Current stock" },
  { href: "/inventory/stock-in", label: "Stock in" },
  { href: "/inventory/stock-out", label: "Stock out" },
  { href: "/inventory/adjustments", label: "Stock adjustment" },
  { href: "/inventory/transfers", label: "Stock transfer" },
  { href: "/inventory/damaged", label: "Damaged / expired stock" },
];
