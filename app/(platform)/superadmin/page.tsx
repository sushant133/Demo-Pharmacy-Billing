import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { formatDateTime, integer, money } from "@/lib/format";
import { listPharmacies, platformOverview } from "@/lib/pharmacies";
import { listPlatformEvents } from "@/lib/platform-events";
import { PlatformEventList } from "@/components/pharmacies/PlatformEventList";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Platform" };
export const dynamic = "force-dynamic";

export default async function SuperAdminHomePage() {
  await requirePagePermission("pharmacy:manage");

  const [overview, { rows }, events] = await withDbRead(() =>
    Promise.all([
      platformOverview(),
      listPharmacies({ page: 1, pageSize: 8 }),
      listPlatformEvents({ pageSize: 8 }),
    ]),
  );

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

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pharmacies" value={integer(overview.pharmacies)} tone="brand" />
        <StatCard label="Active" value={integer(overview.active)} />
        <StatCard
          label="Suspended"
          value={integer(overview.suspended)}
          tone={overview.suspended > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Licences expiring"
          value={integer(overview.licencesExpiring)}
          tone={overview.licencesExpiring > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/*
          The figure worth watching. An account can be active, paid for and
          completely unused; only a count of shops that actually billed
          something tells those apart.
        */}
        <StatCard
          label="Trading (30 days)"
          value={`${integer(overview.tradingLast30)} / ${integer(overview.active)}`}
        />
        <StatCard label="Bills (30 days)" value={integer(overview.billsLast30)} />
        <StatCard label="Revenue (30 days)" value={money(overview.revenueLast30)} />
        <StatCard
          label="Outlets / logins"
          value={`${integer(overview.branches)} / ${integer(overview.users)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
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
                  <th className="px-5 py-3 font-medium">Created</th>
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

        <Card className="px-5 py-2">
          <div className="flex items-center justify-between py-2">
            <h2 className="text-sm font-semibold text-slate-900">Latest actions</h2>
            <Link
              href="/superadmin/activity"
              className="text-sm font-medium text-brand-700 hover:text-brand-800"
            >
              Full log
            </Link>
          </div>
          <PlatformEventList rows={events.rows} />
        </Card>
      </div>
    </>
  );
}
