import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { formatDateTime, integer } from "@/lib/format";
import { pharmacyFilter } from "@/lib/tenant";
import { User } from "@/models/User";
import { listBranches } from "@/lib/branches";
import { assignableRoleOf } from "@/lib/roles";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { StaffFormPanel } from "@/components/staff/StaffFormPanel";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";
import { ModuleTabs } from "@/components/ModuleScaffold";
import { STAFF_TABS } from "../tabs";

export const metadata: Metadata = { title: "User status" };
export const dynamic = "force-dynamic";

/**
 * Who can currently sign in, and the switch that decides it.
 *
 * Disabling an account is the one staff action that can lock a working
 * pharmacist out mid-shift, which is why it used to sit with the platform
 * administrator. What made it safe to hand over is not a confirmation dialog
 * but the rules in lib/staff.ts: you cannot disable yourself, and you cannot
 * disable the last account that can still sign in.
 */
export default async function UserStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const user = await requirePagePermission("user:manage");
  const params = await searchParams;

  const { rows, branches } = await withDbRead(async () => {
    const [rows, branches] = await Promise.all([
      User.find(pharmacyFilter(user)).sort({ isActive: 1, name: 1 }).lean(),
      listBranches(user, false),
    ]);
    return { rows, branches };
  });

  const editing = params.edit
    ? rows.find((row) => String(row._id) === params.edit)
    : undefined;

  const disabled = rows.filter((row) => row.isActive === false);
  const neverSignedIn = rows.filter((row) => !row.lastLoginAt);

  return (
    <>
      <PageHeader
        title="User status"
        subtitle="Which accounts can sign in to this pharmacy right now."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Can sign in" value={integer(rows.length - disabled.length)} />
        <StatCard
          label="Disabled"
          value={integer(disabled.length)}
          tone={disabled.length > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Never signed in"
          value={integer(neverSignedIn.length)}
          hint="Issued but unused"
        />
      </div>

      <ModuleTabs tabs={STAFF_TABS} active="/staff/status" />

      <Card className="mb-4">
        {rows.length === 0 ? (
          <EmptyState title="No accounts" />
        ) : (
          <TableWrap minWidth="32rem" pinFirst pinLast>
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Email</th>
                <th className="th">Status</th>
                <th className="th text-right">Last sign-in</th>
                <th className="th text-right col-actions">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const id = String(row._id);
                const isSelf = String(user.id) === id;

                /*
                  One control, three meanings. Your own row only ever offers
                  View - the screen already refuses to let anybody lock
                  themselves out - so it would be a lie to show it a switch.
                */
                const action = isSelf
                  ? { label: "View details", icon: "view", tone: "primary" } as const
                  : row.isActive === false
                    ? { label: "Activate", icon: "activate", tone: "success" } as const
                    : { label: "Deactivate", icon: "deactivate", tone: "danger" } as const;

                return (
                  <tr key={id} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">
                      {row.name}
                      {isSelf ? (
                        <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                          (you)
                        </span>
                      ) : null}
                    </td>
                    <td className="td text-slate-600">{row.email}</td>
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
                          href={`/staff/status?edit=${id}`}
                          label={action.label}
                          icon={action.icon}
                          tone={action.tone}
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

      {/*
        Disabling stops the next sign-in, not the session already open. Said on
        the screen as well as in the panel, because "I disabled them and they
        are still billing" is the support call this prevents.
      */}
      <p className="text-xs text-slate-500">
        Disabling an account stops it signing in again. A session that is
        already open stays valid until it expires, so ask the person to sign out
        if you need them off the till now.
      </p>

      {editing ? (
        <StaffFormPanel
          returnHref="/staff/status"
          branches={branches.map((branch) => ({
            id: branch.id,
            name: branch.name,
          }))}
          staff={{
            id: String(editing._id),
            name: editing.name,
            email: editing.email,
            role: assignableRoleOf(editing),
            branchId: editing.branchId ? String(editing.branchId) : null,
            isActive: editing.isActive !== false,
            used: Boolean(editing.lastLoginAt),
            isSelf: String(user.id) === String(editing._id),
          }}
        />
      ) : null}
    </>
  );
}
