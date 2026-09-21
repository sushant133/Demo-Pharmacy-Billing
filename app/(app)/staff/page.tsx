import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { listBranches } from "@/lib/branches";
import { formatDateTime, initials, integer } from "@/lib/format";
import { ROLE_LABELS, assignableRoleOf, normalizeRole } from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { User } from "@/models/User";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { StaffFormPanel } from "@/components/staff/StaffFormPanel";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  TableWrap,
} from "@/components/ui";
import { ModuleTabs } from "@/components/ModuleScaffold";
import { STAFF_TABS } from "./tabs";

export const metadata: Metadata = { title: "Staff & users" };
export const dynamic = "force-dynamic";


/**
 * Staff register for one pharmacy.
 *
 * Scoped by `pharmacyId`, so an owner sees their own people and nobody else's.
 * Issuing and withdrawing logins is now done here rather than by the platform
 * administrator; the rules that make that safe - you cannot disable yourself,
 * you cannot disable the last account that can sign in, an account that has
 * been used is disabled rather than deleted - are enforced in lib/staff.ts
 * rather than in the panel, so they hold however the API is reached.
 */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; edit?: string }>;
}) {
  const user = await requirePagePermission("user:manage");
  const params = await searchParams;

  const { rows, branches } = await withDbRead(async () => {
    const [rows, branches] = await Promise.all([
      User.find(pharmacyFilter(user)).sort({ createdAt: 1 }).lean(),
      listBranches(user, true),
    ]);
    return { rows, branches };
  });

  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
  const active = rows.filter((row) => row.isActive !== false).length;
  const signedInThisWeek = rows.filter(
    (row) =>
      row.lastLoginAt &&
      Date.now() - new Date(row.lastLoginAt).getTime() < 7 * 24 * 60 * 60 * 1000,
  ).length;

  const editing = params.edit
    ? rows.find((row) => String(row._id) === params.edit)
    : undefined;

  // Only open branches are offered as a home outlet; a closed one would land
  // that person's sales somewhere the shop has stopped trading.
  const openBranches = branches
    .filter((branch) => branch.isActive)
    .map((branch) => ({ id: branch.id, name: branch.name }));

  return (
    <>
      <PageHeader
        title="Staff & users"
        subtitle="Everyone with a login to this pharmacy."
        actions={
          <Link href="/staff?new=1" className="btn-primary">
            Add staff
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Accounts" value={integer(rows.length)} />
        <StatCard label="Active" value={integer(active)} />
        <StatCard
          label="Disabled"
          value={integer(rows.length - active)}
          tone={rows.length - active > 0 ? "warning" : "default"}
          href={rows.length - active > 0 ? "/staff/status" : undefined}
        />
        <StatCard
          label="Signed in this week"
          value={integer(signedInThisWeek)}
          hint="By last login"
        />
      </div>

      <ModuleTabs tabs={STAFF_TABS} active="/staff" />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No staff accounts"
            description="Only the owner account exists for this pharmacy."
            action={
              <Link href="/staff?new=1" className="btn-primary">
                Add staff
              </Link>
            }
          />
        ) : (
          <TableWrap minWidth="42rem" pinFirst pinLast>
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Email</th>
                <th className="th">Role</th>
                <th className="th">Branch</th>
                <th className="th">Status</th>
                <th className="th text-right">Last sign-in</th>
                <th className="th text-right col-actions">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const id = String(row._id);
                const role = normalizeRole(row.role, row.roleVersion);
                const isSelf = String(user.id) === id;

                return (
                  <tr key={id} className="hover:bg-slate-50">
                    <td className="td">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-800">
                          {initials(row.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900">
                            {row.name}
                            {isSelf ? (
                              <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                                (you)
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="td text-slate-600">
                      {row.email}
                    </td>
                    <td className="td">
                      <Badge tone={role === "admin" ? "brand" : "slate"}>
                        {role ? ROLE_LABELS[role] : String(row.role)}
                      </Badge>
                    </td>
                    <td className="td text-slate-500">
                      {row.branchId
                        ? (branchName.get(String(row.branchId)) ?? "—")
                        : "All branches"}
                    </td>
                    <td className="td">
                      <Badge tone={row.isActive === false ? "rose" : "green"}>
                        {row.isActive === false ? "Disabled" : "Active"}
                      </Badge>
                    </td>
                    <td className="td text-right text-slate-500">
                      {row.lastLoginAt
                        ? formatDateTime(row.lastLoginAt as unknown as Date)
                        : "Never"}
                    </td>
                    <td className="td col-actions">
                      <ActionBar>
                        <ActionIcon
                          label="Edit"
                          icon="edit"
                          tone="primary"
                          href={`/staff?edit=${id}`}
                        />
                      </ActionBar>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {params.new === "1" || editing ? (
        <StaffFormPanel
          branches={openBranches}
          staff={
            editing
              ? {
                  id: String(editing._id),
                  name: editing.name,
                  email: editing.email,
                  role: assignableRoleOf(editing),
                  branchId: editing.branchId ? String(editing.branchId) : null,
                  isActive: editing.isActive !== false,
                  used: Boolean(editing.lastLoginAt),
                  isSelf: String(user.id) === String(editing._id),
                }
              : null
          }
        />
      ) : null}
    </>
  );
}
