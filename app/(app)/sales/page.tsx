import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { pharmacyFilter } from "@/lib/tenant";
import { dateRangeFromStrings, toDateInputValue } from "@/lib/dates";
import { formatDateTime, integer, money } from "@/lib/format";
import { Sale, PAYMENT_MODES, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { DualDateField } from "@/components/DualDateField";
import { Badge, Card, EmptyState, PageHeader, Pagination, StatCard, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Sales" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Sales history.
 *
 * A server component with a plain GET form for filtering: no client JS, the
 * URL is the state, and a filtered view is a shareable, bookmarkable link.
 */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    paymentMode?: string;
    q?: string;
    page?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const today = toDateInputValue();
  // Default to today, which is what staff want nine times out of ten.
  const from = params.from ?? today;
  const to = params.to ?? today;

  const { sales, total, summary } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const filter: Record<string, unknown> = {
      ...pharmacyFilter(user),
      ...branchFilter(scope),
    };
    const { start, end } = dateRangeFromStrings(from, to);
    if (start || end) {
      const range: Record<string, Date> = {};
      if (start) range.$gte = start;
      if (end) range.$lt = end;
      filter.createdAt = range;
    }

    if (params.paymentMode && PAYMENT_MODES.includes(params.paymentMode as PaymentMode)) {
      filter.paymentMode = params.paymentMode;
    }

    if (params.q?.trim()) {
      const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(safe, "i");
      filter.$or = [
        { billNo: pattern },
        { customerName: pattern },
        { "items.medicineName": pattern },
      ];
    }

    const [sales, total, summaryAgg] = await Promise.all([
      Sale.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Sale.countDocuments(filter),
      Sale.aggregate([
        { $match: { ...filter, voidedAt: null } },
        {
          $group: {
            _id: null,
            gross: {
              $sum: {
                $subtract: [
                  "$totalAmount",
                  { $ifNull: ["$returnedTotal", 0] },
                ],
              },
            },
            vat: {
              $sum: {
                $subtract: [
                  "$vatAmount",
                  { $ifNull: ["$returnedVat", 0] },
                ],
              },
            },
            discount: {
              $sum: {
                $subtract: [
                  "$discount",
                  { $ifNull: ["$returnedDiscount", 0] },
                ],
              },
            },
            units: {
              $sum: {
                $subtract: [
                  { $sum: "$items.quantity" },
                  { $ifNull: ["$returnedUnits", 0] },
                ],
              },
            },
          },
        },
      ]),
    ]);

    return {
      sales,
      total,
      summary: (summaryAgg[0] ?? {}) as {
        gross?: number;
        vat?: number;
        discount?: number;
        units?: number;
      },
    };
  });

  // Preserve every filter except `page` when paginating.
  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (params.paymentMode) baseQuery.set("paymentMode", params.paymentMode);
  if (params.q) baseQuery.set("q", params.q);

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle={
          from === to
            ? `Bills for ${from}`
            : `Bills from ${from || "the beginning"} to ${to || "today"}`
        }
        actions={
          <Link href="/sales/returns" className="btn-secondary">
            Record a return
          </Link>
        }
      />

      {/* Filters - a plain GET form, so the URL carries the state. */}
      <Card className="mb-4 p-4">
        <form method="get" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="label">From</p>
              <DualDateField
                id="from"
                name="from"
                defaultValue={from}
                compact
                aria-label="From"
              />
            </div>
            <div className="min-w-0">
              <p className="label">To</p>
              <DualDateField
                id="to"
                name="to"
                defaultValue={to}
                compact
                aria-label="To"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <div>
              <label htmlFor="paymentMode" className="label">
                Payment
              </label>
              <select
                id="paymentMode"
                name="paymentMode"
                defaultValue={params.paymentMode ?? ""}
                className="input"
              >
                <option value="">All modes</option>
                {PAYMENT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {PAYMENT_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="label">
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Bill no, customer, medicine"
                className="input"
              />
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className="btn-primary">
                Apply
              </button>
              <Link href="/sales" className="btn-secondary">
                Reset
              </Link>
            </div>
          </div>
        </form>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Bills" value={integer(total)} tone="brand" />
        <StatCard label="Gross sales" value={money(summary.gross ?? 0)} />
        <StatCard label="VAT collected" value={money(summary.vat ?? 0)} />
        <StatCard label="Units sold" value={integer(summary.units ?? 0)} />
      </div>

      <Card className="overflow-hidden">
        {sales.length === 0 ? (
          <EmptyState
            title="No bills in this range"
            description="Try widening the date range or clearing the filters."
            action={
              <Link href="/sales" className="btn-secondary">
                Reset filters
              </Link>
            }
          />
        ) : (
          <>
            <TableWrap>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Bill no</th>
                  <th className="th">Date &amp; time</th>
                  <th className="th">Customer</th>
                  <th className="th text-right">Items</th>
                  <th className="th">Payment</th>
                  <th className="th">Cashier</th>
                  <th className="th text-right">Total</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sales.map((sale) => (
                  <tr key={String(sale._id)} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/sales/${String(sale._id)}`}
                        className="font-mono font-medium text-brand-700 hover:underline"
                      >
                        {sale.billNo}
                      </Link>
                      {sale.voidedAt ? (
                        <Badge tone="rose" className="ml-2">
                          Voided
                        </Badge>
                      ) : (sale.returnedUnits ?? 0) > 0 ? (
                        <Badge tone="amber" className="ml-2">
                          {(sale.returnedUnits ?? 0) >=
                          sale.items.reduce((sum, item) => sum + item.quantity, 0)
                            ? "Returned"
                            : "Partial return"}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDateTime(sale.createdAt as unknown as Date)}
                    </td>
                    <td className="td">{sale.customerName || "Walk-in"}</td>
                    <td className="td tnum text-right">
                      {sale.items.reduce((sum, item) => sum + item.quantity, 0)}
                    </td>
                    <td className="td">
                      <Badge tone="slate">
                        {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ??
                          sale.paymentMode}
                      </Badge>
                    </td>
                    <td className="td text-slate-600">{sale.soldByName || "—"}</td>
                    <td className="td tnum text-right font-semibold text-slate-900">
                      {money(sale.totalAmount)}
                    </td>
                    <td className="td text-right">
                      <Link
                        href={`/bills/${String(sale._id)}`}
                        className="text-xs font-medium text-slate-500 hover:text-brand-700"
                      >
                        Print
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
              total={total}
              baseHref={`/sales?${baseQuery.toString()}`}
            />
          </>
        )}
      </Card>
    </>
  );
}
