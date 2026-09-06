import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { formatDateTime, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { storedBillNo } from "@/models/Counter";
import { Sale } from "@/models/Sale";
import { Badge, Card, EmptyState, PageHeader, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Returns" };
export const dynamic = "force-dynamic";

export default async function SalesReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;
  await connectDB();

  const q = params.q?.trim() ?? "";
  const tenant = pharmacyFilter(user);

  const lookup = q
    ? await Sale.findOne(
        objectIdOrBill(q)
          ? { _id: q, ...tenant }
          : { billNo: storedBillNo(q), ...tenant },
      )
        .select("billNo voidedAt returnedUnits")
        .lean()
    : null;

  const recent = await Sale.find({
    ...tenant,
    "returns.0": { $exists: true },
  })
    .sort({ updatedAt: -1 })
    .limit(25)
    .select("billNo customerName returnedUnits returnedTotal returns createdAt")
    .lean();

  const canRecord = can(user.role, "sale:void");

  return (
    <>
      <PageHeader
        title="Returns"
        subtitle="Look up a bill and put sold medicine back — even part of a strip. Type how many tablets came back."
        actions={
          <Link href="/sales" className="btn-secondary">
            Sales register
          </Link>
        }
      />

      <Card className="mb-6 p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="q" className="label">
              Bill number
            </label>
            <input
              id="q"
              name="q"
              defaultValue={q}
              placeholder="INV-2082-83-000173"
              className="input"
              autoCapitalize="characters"
            />
          </div>
          <button type="submit" className="btn-primary">
            Find bill
          </button>
        </form>

        {q && !lookup ? (
          <p className="mt-3 text-sm text-rose-700">No bill matches that number.</p>
        ) : null}

        {lookup ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <p className="font-mono text-sm font-semibold text-slate-900">
                {lookup.billNo}
              </p>
              <p className="text-xs text-slate-500">
                {lookup.voidedAt
                  ? "Voided — cannot take a return"
                  : (lookup.returnedUnits ?? 0) > 0
                    ? `${lookup.returnedUnits} unit(s) already returned`
                    : "Open this bill to record a return"}
              </p>
            </div>
            <Link href={`/sales/${String(lookup._id)}`} className="btn-primary">
              {canRecord && !lookup.voidedAt ? "Open and return" : "Open bill"}
            </Link>
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
          Recent returns
        </h2>
        {recent.length === 0 ? (
          <EmptyState
            title="No returns recorded yet"
            description="Find a bill above, then type how many tablets came back. 6 from a strip of 10 is fine."
          />
        ) : (
          <TableWrap>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Bill no</th>
                <th className="th">Customer</th>
                <th className="th">Last return</th>
                <th className="th text-right">Units</th>
                <th className="th text-right">Refund</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recent.map((sale) => {
                const last = sale.returns?.[sale.returns.length - 1];
                return (
                  <tr key={String(sale._id)} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/sales/${String(sale._id)}`}
                        className="font-mono font-medium text-brand-700 hover:underline"
                      >
                        {sale.billNo}
                      </Link>
                      <Badge tone="amber" className="ml-2">
                        Returned
                      </Badge>
                    </td>
                    <td className="td">{sale.customerName || "Walk-in"}</td>
                    <td className="td text-slate-600">
                      {last?.returnedAt
                        ? formatDateTime(last.returnedAt as unknown as Date)
                        : "—"}
                      {last?.returnedByName ? ` · ${last.returnedByName}` : ""}
                    </td>
                    <td className="td tnum text-right">{sale.returnedUnits ?? 0}</td>
                    <td className="td tnum text-right font-medium">
                      {money(sale.returnedTotal ?? 0)}
                    </td>
                    <td className="td text-right">
                      <Link
                        href={`/sales/${String(sale._id)}`}
                        className="text-xs font-medium text-brand-700 hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

function objectIdOrBill(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}
