import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import {
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  assignableRoleOf,
  can,
} from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { User } from "@/models/User";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";
import { ModuleTabs } from "@/components/ModuleScaffold";
import { STAFF_TABS } from "../tabs";

export const metadata: Metadata = { title: "Roles & permissions" };
export const dynamic = "force-dynamic";

/**
 * What each role in this pharmacy can actually do.
 *
 * The matrix is read straight from lib/roles.ts rather than retyped, so it
 * cannot drift from the rules the middleware and the API handlers enforce. Add
 * a permission there and a row appears here; change who holds it and the ticks
 * move. That is the whole point of the screen: an owner deciding what to hand
 * a new counter assistant should be reading the enforcement, not a description
 * of it that somebody updated by hand eighteen months ago.
 *
 * Only pharmacy-side roles are listed. Superadmin runs the platform and
 * creates pharmacies; it is not a role this dashboard grants, describes or
 * lets anyone assign, and showing it here would only invite the question.
 */

/** Grouped the way a pharmacist thinks about the shop, not the way ids sort. */
const GROUPS: Array<{ title: string; prefixes: string[] }> = [
  { title: "Selling", prefixes: ["sale", "customer"] },
  { title: "Catalogue & stock", prefixes: ["medicine", "batch"] },
  { title: "Buying", prefixes: ["purchase", "supplier", "payment"] },
  { title: "Books", prefixes: ["report"] },
  { title: "Administration", prefixes: ["user", "branch", "settings"] },
];

const VERBS: Record<string, string> = {
  read: "View",
  write: "Create and edit",
  create: "Create",
  delete: "Delete",
  void: "Void and return",
  post: "Post",
  cancel: "Cancel",
  manage: "Manage",
  financial: "See money figures",
  export: "Export",
  discount: "Discount",
  credit: "Sell on credit",
};

/** Plain-language name for a permission, e.g. "Void and return · sale". */
function describe(permission: string): string {
  const [area = "", verb = ""] = permission.split(":");
  return `${VERBS[verb] ?? verb} · ${area}`;
}

export default async function RolesPage() {
  const user = await requirePagePermission("user:manage");

  // How many people actually hold each role, so the matrix reads as this
  // shop's arrangement rather than as an abstract table. An owner asking
  // "can my cashier do X" usually also wants to know how many cashiers exist.
  const headcount = await withDbRead(async () => {
    const rows = await User.find({
      ...pharmacyFilter(user),
      isActive: { $ne: false },
    })
      .select("role roleVersion")
      .lean();

    const counts = new Map<string, number>();
    for (const row of rows) {
      const role = assignableRoleOf(row);
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return counts;
  });

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role in this pharmacy is allowed to do."
        actions={
          <Link href="/staff?new=1" className="btn-primary">
            Add staff
          </Link>
        }
      />

      <ModuleTabs tabs={STAFF_TABS} active="/staff/roles" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ASSIGNABLE_ROLES.map((role) => {
          const held = headcount.get(role) ?? 0;
          return (
            <Card key={role} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <Badge tone={role === "admin" ? "brand" : "slate"}>
                  {ROLE_LABELS[role]}
                </Badge>
                <span className="tnum shrink-0 text-xs text-slate-400">
                  {held === 0
                    ? "nobody"
                    : held === 1
                      ? "1 person"
                      : `${held} people`}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {ROLE_DESCRIPTIONS[role]}
              </p>
            </Card>
          );
        })}
      </div>

      {GROUPS.map((group) => {
        const rows = PERMISSIONS.filter(
          (permission) =>
            permission !== "pharmacy:manage" &&
            group.prefixes.includes(permission.split(":")[0] ?? ""),
        );
        if (rows.length === 0) return null;

        return (
          <Card key={group.title} className="mb-4 overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
              <p className="text-sm font-semibold text-slate-900">{group.title}</p>
            </div>
            <TableWrap>
              <thead>
                <tr>
                  <th className="th">Capability</th>
                  <th className="th hidden lg:table-cell">Permission</th>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <th key={role} className="th text-center whitespace-nowrap">
                      {ROLE_LABELS[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((permission) => (
                  <tr key={permission} className="hover:bg-slate-50">
                    <td className="td text-slate-900">{describe(permission)}</td>
                    <td className="td hidden font-mono text-xs text-slate-500 lg:table-cell">
                      {permission}
                    </td>
                    {ASSIGNABLE_ROLES.map((role) => {
                      const allowed = can(role, permission);
                      return (
                        <td key={role} className="td text-center">
                          {/*
                            A tick and a dash rather than "Allowed"/"No" in
                            every cell: five columns of words is a wall, and
                            the eye reads a column of ticks far faster. The
                            text stays for screen readers.
                          */}
                          <span
                            className={
                              allowed
                                ? "font-semibold text-emerald-600"
                                : "text-slate-300"
                            }
                            aria-hidden="true"
                          >
                            {allowed ? "✓" : "—"}
                          </span>
                          <span className="sr-only">
                            {allowed ? "Allowed" : "Not allowed"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        );
      })}

      <Card className="mb-4 p-4 sm:p-5">
        <p className="text-sm font-semibold text-slate-900">
          Roles are fixed, and that is deliberate
        </p>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          These five sets are enforced in one place and cannot be edited per
          person, so what this table says is what the server does - for the
          screens in the menu, for the API behind them, and for anyone who
          reaches that API another way. Pick the closest role when you issue a
          login; if none of them fits how your shop actually works, that is
          worth saying rather than working around.
        </p>
      </Card>
    </>
  );
}
