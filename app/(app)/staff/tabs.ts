import type { ModuleTab } from "@/components/ModuleScaffold";

/** Sub-navigation for the staff module, shared by all four screens. */
export const STAFF_TABS: ModuleTab[] = [
  { href: "/staff", label: "Staff members" },
  { href: "/staff/roles", label: "Roles & permissions" },
  { href: "/staff/status", label: "User status" },
  { href: "/staff/activity", label: "Activity history" },
];
