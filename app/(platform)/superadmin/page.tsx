import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listPharmacies, pharmacyCounts } from "@/lib/pharmacies";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Platform" };
export const dynamic = "force-dynamic";

export default async function SuperAdminHomePage() {
  await requirePagePermission("pharmacy:manage");

  const [counts, { rows }] = await Promise.all([
    pharmacyCounts(),
    listPharmacies({ page: 1, pageSize: 8 }),
  ]);

  return (
    <>
      <PageHeader
        title="Platform"
        subtitle="Create pharmacy accounts. Each owner gets their own catalogue, stock, bills and settings."
        actions={
          <Link href="/superadmin/pharmacies/new" className="btn-primary">
            New pharmacy
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Pharmacies" value={String(counts.total)} tone="brand" />
        <StatCard label="Active" value={String(counts.active)} />
        <StatCard
          label="Suspended"
          value={String(counts.suspended)}
          tone={counts.suspended > 0 ? "warning" : "default"}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Recent pharmacies</h2>
          <Link href="/superadmin/pharmacies" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            View all
          </Link>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title="No pharmacies yet"
            description="Create an account for a pharmacy owner. They sign in to their own shop; you stay here."
            action={
              <Link href="/superadmin/pharmacies/new" className="btn-primary">
                Create the first pharmacy
              </Link>
            }
          />
        ) : (
          <TableWrap>
            <thead className="text-left">
              <tr className="border-b border-slate-100 text-left text-xs tracking-wide text-slate-500 uppercase">
                <th className="px-4 py-3 font-medium sm:px-5">Pharmacy</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-4 py-3 font-medium sm:px-5">Status</th>
                <th className="px-5 py-3 font-medium">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <Link href={`/superadmin/pharmacies/${row.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {row.name}
                    </Link>
                    <p className="text-xs text-slate-500">{row.slug}</p>
                  </td>
                  <td className="px-5 py-3">
                    <p>{row.ownerName}</p>
                    <p className="text-xs text-slate-500">{row.ownerEmail}</p>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={row.status === "active" ? "green" : "amber"}>
                      {row.status === "active" ? "Active" : "Suspended"}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {row.createdAt ? formatDateTime(row.createdAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
