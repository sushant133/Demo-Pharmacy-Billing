import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  type SupplierPaymentMethod,
} from "@/lib/constants";
import { dateRangeFromStrings, toDateInputValue } from "@/lib/dates";
import { withDbRead } from "@/lib/db";
import { formatDate, integer, money } from "@/lib/format";
import { getTotalPayables } from "@/lib/suppliers";
import { pharmacyFilter } from "@/lib/tenant";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import { SupplierPaymentPanel } from "@/components/finance/SupplierPaymentPanel";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
} from "@/components/ui";

export const metadata: Metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Money paid out to suppliers, newest first.
 *
 * Payments are append-only records against a supplier. This screen is the
 * pharmacy-wide read of the same data - one place to answer "what went out
 * this month, and to whom" - and, since the panel landed, the place to record
 * one without opening a supplier first, which is the wrong way round for
 * anybody sitting down with a pile of cheques.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    method?: string;
    page?: string;
    new?: string;
  }>;
}) {
  const user = await requirePagePermission("payment:write");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const today = toDateInputValue();
  const monthStart = `${today.slice(0, 7)}-01`;

  const askedFrom = (params.from ?? monthStart).trim();
  const askedTo = (params.to ?? today).trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const method = SUPPLIER_PAYMENT_METHODS.includes(
    params.method as SupplierPaymentMethod,
  )
    ? (params.method as SupplierPaymentMethod)
    : null;

  const { rows, total, rangeTotal, allTime, payables, supplierName } =
    await withDbRead(async () => {
      const { start, end } = dateRangeFromStrings(from, to);
      const filter: Record<string, unknown> = { ...pharmacyFilter(user) };
      if (start || end) {
        const range: Record<string, Date> = {};
        if (start) range.$gte = start;
        if (end) range.$lt = end;
        filter.paidOn = range;
      }
      if (method) filter.method = method;

      const [rows, total, sums, lifetime, payables, suppliers] = await Promise.all([
        SupplierPayment.find(filter)
          .sort({ paidOn: -1, createdAt: -1 })
          .skip((page - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .lean(),
        SupplierPayment.countDocuments(filter),
        // Over everything matched, not just the page shown: a total that
        // changed when you turned the page would be a total nobody trusts.
        SupplierPayment.aggregate<{ _id: null; amount: number }>([
          { $match: filter },
          { $group: { _id: null, amount: { $sum: "$amount" } } },
        ]),
        SupplierPayment.aggregate<{ _id: null; amount: number }>([
          { $match: pharmacyFilter(user) },
          { $group: { _id: null, amount: { $sum: "$amount" } } },
        ]),
        getTotalPayables(user),
        Supplier.find(pharmacyFilter(user)).select({ name: 1 }).lean(),
      ]);

      return {
        rows,
        total,
        rangeTotal: sums[0]?.amount ?? 0,
        allTime: lifetime[0]?.amount ?? 0,
        payables,
        supplierName: new Map(suppliers.map((s) => [String(s._id), s.name])),
      };
    });

  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (method) baseQuery.set("method", method);
  const baseHref = baseQuery.toString()
    ? `/payments?${baseQuery.toString()}`
    : "/payments";

  const filtered = Boolean(method || from !== monthStart || to !== today);

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle={`Money paid out to suppliers, ${from} to ${to}.`}
        actions={
          <>
            <Link href="/receivables" className="btn-secondary">
              Receivables
            </Link>
            <Link
              href={`/payments?new=1${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
              className="btn-primary"
            >
              Record a payment
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Paid in this range"
          value={money(rangeTotal)}
          hint={`${integer(total)} payment${total === 1 ? "" : "s"}`}
          tone="brand"
        />
        <StatCard label="Paid out, all time" value={money(allTime)} />
        {/*
          What is still owed the other way. A payments screen that only shows
          what has gone out answers half the question somebody came with.
        */}
        <StatCard
          label="Still owed to suppliers"
          value={money(payables.outstanding)}
          hint={`${integer(payables.supplierCount)} supplier${payables.supplierCount === 1 ? "" : "s"}`}
          tone={payables.outstanding > 0 ? "warning" : "default"}
          href="/suppliers?status=owing"
        />
        <StatCard
          label="Overdue"
          value={money(payables.overdue)}
          hint="Past the invoice due date"
          tone={payables.overdue > 0 ? "danger" : "default"}
          href={payables.overdue > 0 ? "/suppliers?status=owing" : undefined}
        />
      </div>

      <Card className="mt-4 mb-4 p-3.5 sm:p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <label htmlFor="from" className="label">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={from}
              className="input tnum"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="to" className="label">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={to}
              className="input tnum"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="method" className="label">
              Method
            </label>
            <select
              id="method"
              name="method"
              defaultValue={method ?? ""}
              className="input"
            >
              <option value="">All methods</option>
              {SUPPLIER_PAYMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {SUPPLIER_PAYMENT_METHOD_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Apply
            </button>
            {filtered ? (
              <Link href="/payments" className="btn-secondary">
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "Nothing matches these filters" : "No payments recorded"}
            description={
              filtered
                ? "Try widening the dates, or clearing the method."
                : "Money paid out to a supplier appears here, whether it was recorded from this screen or from their ledger."
            }
            action={
              filtered ? (
                <Link href="/payments" className="btn-secondary">
                  Reset filters
                </Link>
              ) : (
                <Link href="/payments?new=1" className="btn-primary">
                  Record a payment
                </Link>
              )
            }
          />
        ) : (
          <>
            <TableWrap minWidth="42rem" pinFirst>
              <thead>
                <tr>
                  <th className="th">Paid on</th>
                  <th className="th">Supplier</th>
                  <th className="th">Against</th>
                  <th className="th">Method</th>
                  <th className="th">Reference</th>
                  <th className="th">Recorded by</th>
                  <th className="th text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={String(row._id)} className="hover:bg-slate-50">
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDate(row.paidOn as unknown as Date)}
                    </td>
                    <td className="td">
                      <Link
                        href={`/suppliers/${String(row.supplierId)}`}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {supplierName.get(String(row.supplierId)) ?? "Supplier"}
                      </Link>
                    </td>
                    <td className="td text-slate-500">
                      {row.grnNo ? (
                        <span className="font-mono text-xs">{row.grnNo}</span>
                      ) : (
                        "On account"
                      )}
                    </td>
                    <td className="td">
                      <Badge tone="slate">
                        {SUPPLIER_PAYMENT_METHOD_LABELS[
                          row.method as SupplierPaymentMethod
                        ] ?? row.method}
                      </Badge>
                    </td>
                    <td className="td max-w-[10rem] truncate text-slate-500">
                      {row.reference || "—"}
                    </td>
                    <td className="td text-slate-600">
                      {row.recordedByName || "—"}
                    </td>
                    <td className="td tnum text-right font-semibold text-slate-900">
                      {money(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
              total={total}
              baseHref={baseHref}
            />
          </>
        )}
      </Card>

      {params.new === "1" ? (
        <SupplierPaymentPanel returnHref={baseHref} />
      ) : null}
    </>
  );
}
