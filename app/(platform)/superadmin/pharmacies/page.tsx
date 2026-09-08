import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listPharmacies, pharmacyCounts } from "@/lib/pharmacies";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Pharmacies" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const TABS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
] as const;

export default async function PharmaciesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  await requirePagePermission("pharmacy:manage");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const status = (params.status ?? "all") as (typeof TABS)[number]["value"];

  const [{ rows, total }, counts] = await Promise.all([
    listPharmacies({ q: params.q, status, page, pageSize: PAGE_SIZE }),
    pharmacyCounts(),
  ]);

  return (
    <>
      <PageHeader
        title="Pharmacies"
        subtitle="Each account is a sealed shop: catalogue, stock, bills and settings never mix."
        actions={
          <Link href="/superadmin/pharmacies/new" className="btn-primary">
            New pharmacy
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Total" value={String(counts.total)} />
        <StatCard label="Active" value={String(counts.active)} tone="brand" />
        <StatCard label="Suspended" value={String(counts.suspended)} />
      </div>

      <form className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="q" className="label">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Name, slug or owner email"
            className="input"
          />
        </div>
        <input type="hidden" name="status" value={status} />
        <button type="submit" className="btn-secondary">
          Search
        </button>
      </form>

      <div className="mb-4 flex gap-1">
        {TABS.map((tab) => {
          const href =
            tab.value === "all"
              ? "/superadmin/pharmacies"
              : `/superadmin/pharmacies?status=${tab.value}`;
          const active = status === tab.value;
          return (
            <Link
              key={tab.value}
              href={href}
              className={cx(
                "rounded-lg px-3 py-1.5 text-sm font-medium",
                active
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No pharmacies match"
            description="Create an account, or clear the search."
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
                <th className="px-5 py-3 font-medium">Owner login</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Last sign-in</th>
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
                    {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        total={total}
        baseHref={`/superadmin/pharmacies${status !== "all" ? `?status=${status}` : ""}`}
      />
    </>
  );
}
