import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listPharmacies } from "@/lib/pharmacies";
import { Badge, Card, EmptyState, PageHeader, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Backups" };
export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  await requirePagePermission("pharmacy:manage");
  const { rows } = await listPharmacies({ page: 1, pageSize: 100 });

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle="Download one pharmacy at a time from the server database. Each file is sealed to that shop."
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No pharmacies to back up"
            description="Create a pharmacy first. Its catalogue, stock and bills will be downloadable from here."
            action={
              <Link href="/superadmin/pharmacies/new" className="btn-primary">
                New pharmacy
              </Link>
            }
          />
        ) : (
          <TableWrap>
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs tracking-wide text-slate-500 uppercase">
                <th className="px-5 py-3 font-medium">Pharmacy</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3 font-medium">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/superadmin/pharmacies/${row.id}`}
                      className="font-medium text-slate-900 hover:text-brand-700"
                    >
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
                  <td className="px-5 py-3 text-right">
                    <a
                      href={`/api/pharmacies/${row.id}/backup`}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      Download backup
                    </a>
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
