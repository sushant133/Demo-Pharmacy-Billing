import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listPharmacies, pharmacyCounts } from "@/lib/pharmacies";
import { PharmacyStatusToggle } from "@/components/pharmacies/PharmacyStatusToggle";
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
  const status =
    TABS.find((tab) => tab.value === params.status)?.value ?? "all";

  // Carried into the tabs and the pager so a search survives both. Without it,
  // narrowing to Suspended or stepping to page 2 silently dropped `q` and
  // showed the unfiltered list under a search box that still held the term.
  const baseQuery = new URLSearchParams();
  if (params.q) baseQuery.set("q", params.q);
  if (status !== "all") baseQuery.set("status", status);

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
            placeholder="Name, owner, PAN, licence, phone or city"
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
          const tabQuery = new URLSearchParams(baseQuery);
          if (tab.value === "all") tabQuery.delete("status");
          else tabQuery.set("status", tab.value);
          tabQuery.delete("page");

          const active = status === tab.value;
          return (
            <Link
              key={tab.value}
              href={`/superadmin/pharmacies?${tabQuery.toString()}`}
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
                <th className="px-4 py-3 font-medium sm:px-5">Pharmacy</th>
                <th className="px-5 py-3 font-medium">Owner login</th>
                <th className="px-4 py-3 font-medium sm:px-5">Status</th>
                <th className="px-5 py-3 font-medium">Last sign-in</th>
                <th className="px-5 py-3 text-right font-medium">Access</th>
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
                    <p className="text-xs text-slate-500">
                      {row.slug}
                      {row.city ? ` · ${row.city}` : ""}
                      {row.pan ? ` · PAN ${row.pan}` : ""}
                    </p>
                  </td>
                  <td className="px-5 py-3">
                    <p>{row.ownerName}</p>
                    <p className="text-xs break-all text-slate-500">
                      {row.ownerEmail}
                    </p>
                    {row.ownerPhone ? (
                      <p className="text-xs text-slate-500">{row.ownerPhone}</p>
                    ) : null}
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={row.status === "active" ? "green" : "amber"}>
                      {row.status === "active" ? "Active" : "Suspended"}
                    </Badge>
                    {row.status === "suspended" && row.statusReason ? (
                      <p className="mt-1 text-xs text-slate-500">{row.statusReason}</p>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : "Never"}
                  </td>
                  <td className="px-5 py-3">
                    <PharmacyStatusToggle
                      id={row.id}
                      name={row.name}
                      status={row.status}
                    />
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
        baseHref={`/superadmin/pharmacies?${baseQuery.toString()}`}
      />
    </>
  );
}
