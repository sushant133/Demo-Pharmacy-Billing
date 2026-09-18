import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { integer, money } from "@/lib/format";
import { round2 } from "@/lib/purchase-math";
import { can } from "@/lib/roles";
import { getBalancesFor, getTotalPayables } from "@/lib/suppliers";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { Supplier } from "@/models/Supplier";
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
import { SupplierFormPanel } from "@/components/suppliers/SupplierFormPanel";

export const metadata: Metadata = { title: "Suppliers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const TABS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "owing", label: "Money owed" },
  { value: "inactive", label: "Inactive" },
] as const;

/**
 * Supplier list with derived balances.
 *
 * "Owed" is computed from posted purchases minus payments, never stored, so
 * the figure on this screen is always reconcilable against the underlying
 * documents.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    page?: string;
    new?: string;
    edit?: string;
  }>;
}) {
  const user = await requirePagePermission("supplier:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const status = (params.status ?? "all") as (typeof TABS)[number]["value"];
  const canWrite = can(user.role, "supplier:write");

  const filter: Record<string, unknown> = { ...pharmacyFilter(user) };
  if (status === "active" || status === "owing") filter.isActive = { $ne: false };
  if (status === "inactive") filter.isActive = false;

  if (params.q?.trim()) {
    const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { name: pattern },
      { contactPerson: pattern },
      { phone: pattern },
      { panNo: pattern },
    ];
  }

  // "Owing" filters on a derived value, so that page needs the full set first.
  const fetchAll = status === "owing";

  const [docs, total, payables, balances] = await withDbRead(async () => {
    const [docs, total, payables] = await Promise.all([
      Supplier.find(filter)
        .sort({ name: 1 })
        .skip(fetchAll ? 0 : (page - 1) * PAGE_SIZE)
        .limit(fetchAll ? 1000 : PAGE_SIZE)
        .lean(),
      Supplier.countDocuments(filter),
      getTotalPayables(user),
    ]);
    const balances = await getBalancesFor(
      docs.map((doc) => doc._id),
      pharmacyObjectId(user),
    );
    return [docs, total, payables, balances] as const;
  });

  let rows = docs.map((doc) => {
    const balance = balances.get(String(doc._id)) ?? { purchased: 0, paid: 0 };
    return {
      id: String(doc._id),
      name: doc.name,
      contactPerson: doc.contactPerson ?? "",
      phone: doc.phone ?? "",
      panNo: doc.panNo ?? "",
      paymentTermsDays: doc.paymentTermsDays ?? 0,
      openingBalance: doc.openingBalance ?? 0,
      email: doc.email ?? "",
      address: doc.address ?? "",
      notes: doc.notes ?? "",
      isActive: doc.isActive !== false,
      purchased: balance.purchased,
      outstanding: round2(
        (doc.openingBalance ?? 0) + balance.purchased - balance.paid,
      ),
    };
  });

  if (status === "owing") {
    rows = rows.filter((row) => row.outstanding > 0);
  }

  const shown = status === "owing" ? rows.length : total;
  const editing = params.edit ? rows.find((row) => row.id === params.edit) : undefined;

  const baseQuery = new URLSearchParams();
  if (params.q) baseQuery.set("q", params.q);
  if (status !== "all") baseQuery.set("status", status);

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Who you buy from, and what you still owe them."
        actions={
          canWrite ? (
            <Link href="/suppliers?new=1" className="btn-primary">
              Add supplier
            </Link>
          ) : null
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Suppliers" value={integer(payables.supplierCount)} tone="brand" />
        <StatCard
          label="Total payable"
          value={money(payables.outstanding)}
          tone={payables.outstanding > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Overdue"
          value={money(payables.overdue)}
          hint="Past the agreed credit period"
          tone={payables.overdue > 0 ? "danger" : "default"}
        />
        <StatCard label="Listed here" value={integer(shown)} />
      </div>

      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {TABS.map((tab) => {
            const tabQuery = new URLSearchParams(baseQuery);
            if (tab.value === "all") tabQuery.delete("status");
            else tabQuery.set("status", tab.value);
            tabQuery.delete("page");

            return (
              <Link
                key={tab.value}
                href={`/suppliers?${tabQuery.toString()}`}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  status === tab.value
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>

        <form method="get" className="grid gap-3 sm:grid-cols-3">
          {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
          <div className="sm:col-span-2">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Name, contact, phone or PAN"
              className="input"
            />
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Search
            </button>
            <Link href="/suppliers" className="btn-secondary">
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No suppliers yet"
            description="Stock enters through purchases, and every purchase belongs to a supplier. Add your first distributor to get started."
            action={
              canWrite ? (
                <Link href="/suppliers?new=1" className="btn-primary">
                  Add supplier
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap minWidth="36rem" pinFirst>
              <thead className="border-b border-slate-200 bg-slate-50">
                {/*
                  A phone keeps the name and what is owed - the two things
                  this list is opened to find. The contact, the PAN and the
                  credit terms fold under the name; lifetime purchases are a
                  reporting figure and wait for a wide screen.
                */}
                <tr>
                  <th className="th">Supplier</th>
                  <th className="th">Contact</th>
                  <th className="th">PAN</th>
                  <th className="th text-right">Terms</th>
                  <th className="th text-right">Purchased</th>
                  <th className="th text-right">Owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/suppliers/${row.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {!row.isActive ? (
                        <Badge tone="slate" className="ml-2">
                          Inactive
                        </Badge>
                      ) : null}
                    </td>
                    <td className="td text-slate-600">
                      {row.contactPerson || "—"}
                      {row.phone ? (
                        <span className="block text-xs text-slate-400">{row.phone}</span>
                      ) : null}
                    </td>
                    <td className="td font-mono text-xs text-slate-600">
                      {row.panNo || "—"}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {row.paymentTermsDays > 0 ? `${row.paymentTermsDays}d` : "—"}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {money(row.purchased)}
                    </td>
                    <td className="td tnum text-right">
                      <span
                        className={
                          row.outstanding > 0
                            ? "font-semibold text-rose-600"
                            : "text-slate-400"
                        }
                      >
                        {money(row.outstanding)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            {status !== "owing" ? (
              <Pagination
                page={page}
                totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
                total={total}
                baseHref={`/suppliers?${baseQuery.toString()}`}
              />
            ) : null}
          </>
        )}
      </Card>

      {canWrite && (params.new === "1" || editing) ? (
        <SupplierFormPanel
          canDelete={can(user.role, "supplier:delete")}
          supplier={
            editing
              ? {
                  id: editing.id,
                  name: editing.name,
                  contactPerson: editing.contactPerson,
                  phone: editing.phone,
                  email: editing.email,
                  address: editing.address,
                  panNo: editing.panNo,
                  paymentTermsDays: editing.paymentTermsDays,
                  openingBalance: editing.openingBalance,
                  notes: editing.notes,
                  isActive: editing.isActive,
                }
              : null
          }
        />
      ) : null}
    </>
  );
}
