import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { listBranches } from "@/lib/branches";
import { integer, money } from "@/lib/format";
import { BranchFormPanel } from "@/components/branches/BranchFormPanel";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  TableWrap,
} from "@/components/ui";

export const metadata: Metadata = { title: "Branches" };
export const dynamic = "force-dynamic";

/**
 * Branch registry.
 *
 * Each outlet holds its own stock. This screen is where an admin renames
 * them, assigns the default, and closes one once its lots and staff have
 * moved.
 *
 * Opening one is not here. An outlet is a billing identity that prints its
 * own name and PAN on a VAT invoice, and it splits the shop's stock in two,
 * so the platform opens it on request rather than the shop minting one for
 * itself. Everything after that is the shop's own to run.
 */
export default async function BranchesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const user = await requirePagePermission("branch:manage");
  const params = await searchParams;
  const branches = await withDbRead(() => listBranches(user, true));

  const editing = params.edit
    ? (branches.find((branch) => branch.id === params.edit) ?? null)
    : null;

  const active = branches.filter((branch) => branch.isActive);
  const stockValue = branches.reduce((sum, branch) => sum + branch.stockValue, 0);

  return (
    <>
      <PageHeader
        title="Branches"
        subtitle="Each outlet has its own stock. Sales and receipts land where the user stands."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Outlets" value={integer(active.length)} />
        <StatCard label="Closed" value={integer(branches.length - active.length)} />
        <StatCard label="Stock at cost" value={money(stockValue)} />
      </div>

      <Card>
        {branches.length === 0 ? (
          <EmptyState
            title="No branches yet"
            description="Ask MantraMed support to open your first outlet. Existing stock and users will attach to it."
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="th">Branch</th>
                <th className="th text-right">Lots</th>
                <th className="th text-right">Units</th>
                <th className="th text-right">Stock value</th>
                <th className="th text-right">Staff</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {branches.map((branch) => (
                <tr key={branch.id} className="hover:bg-slate-50">
                  <td className="td">
                    <p className="font-medium text-slate-900">{branch.name}</p>
                    <p className="text-xs text-slate-500">
                      {branch.code}
                      {branch.address ? ` · ${branch.address}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {branch.isDefault ? <Badge tone="brand">Default</Badge> : null}
                      {branch.isActive ? null : <Badge tone="slate">Closed</Badge>}
                    </div>
                  </td>
                  <td className="td tnum text-right">{integer(branch.lotCount)}</td>
                  <td className="td tnum text-right">{integer(branch.unitCount)}</td>
                  <td className="td tnum text-right">{money(branch.stockValue)}</td>
                  <td className="td tnum text-right">{integer(branch.staffCount)}</td>
                  <td className="td text-right">
                    <Link href={`/branches?edit=${branch.id}`} className="text-sm font-medium text-brand-700">
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <p className="mt-4 max-w-2xl text-xs leading-relaxed text-slate-500">
        Need another outlet? Send MantraMed support the outlet&rsquo;s name,
        address and PAN and they will open it against this pharmacy. It appears
        here as soon as it is created, and you can rename it, make it the
        default or close it yourself.
      </p>

      {editing ? (
        <BranchFormPanel
          branch={{
            id: editing.id,
            code: editing.code,
            name: editing.name,
            address: editing.address,
            phone: editing.phone,
            panNo: editing.panNo,
            notes: editing.notes,
            isDefault: editing.isDefault,
            isActive: editing.isActive,
          }}
        />
      ) : null}
    </>
  );
}
