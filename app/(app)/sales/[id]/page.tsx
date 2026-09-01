import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { formatDateTime, formatExpiry, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { Sale, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { objectIdSchema } from "@/lib/validation";
import { VoidSaleAction } from "@/components/sales/VoidSaleAction";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Bill detail" };
export const dynamic = "force-dynamic";

/**
 * Read-only detail of one bill, inside the app chrome.
 *
 * The stripped-down printable version lives at /bills/[id]; this screen is for
 * looking a sale up, seeing which batches went out, and reprinting.
 */
export default async function SaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePagePermission("sale:read");
  const { id } = await params;

  const sale = await withDbRead(async () => {
    const sale = await Sale.findOne(
      objectIdSchema.safeParse(id).success ? { _id: id } : { billNo: id.toUpperCase() },
    ).lean();

    if (!sale) notFound();
    const scope = await resolveViewScope(session);
    try {
      assertVisibleInScope(sale.branchId, scope);
    } catch {
      notFound();
    }
    return sale;
  });

  const units = sale.items.reduce((sum, item) => sum + item.quantity, 0);
  const voided = Boolean(sale.voidedAt);
  const canVoid = !voided && can(session.role, "sale:void");

  return (
    <>
      <PageHeader
        title={sale.billNo}
        subtitle={`${formatDateTime(sale.createdAt as unknown as Date)} · ${units} unit${units === 1 ? "" : "s"} · ${sale.items.length} line${sale.items.length === 1 ? "" : "s"}`}
        actions={
          <>
            <Link href="/sales" className="btn-secondary">
              Back
            </Link>
            <Link href={`/bills/${String(sale._id)}`} className="btn-primary">
              Open printable bill
            </Link>
          </>
        }
      />

      {voided ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-rose-800">
            This bill was voided on{" "}
            {formatDateTime(sale.voidedAt as unknown as Date)}
            {sale.voidedByName ? ` by ${sale.voidedByName}` : ""}.
          </p>
          <p className="mt-1 text-xs text-rose-700">
            Its stock was returned to the batches below, and it is excluded from
            takings, profit and stock alerts.
            {sale.voidReason ? ` Reason: ${sale.voidReason}` : ""}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            Dispensed items
          </h2>

          <TableWrap>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Medicine</th>
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Rate</th>
                <th className="th text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sale.items.map((item, index) => (
                <tr key={`${String(item.batchId)}-${index}`}>
                  <td className="td font-medium text-slate-900">{item.medicineName}</td>
                  <td className="td font-mono text-xs text-slate-600">
                    {item.batchNumber}
                  </td>
                  <td className="td text-slate-600">{formatExpiry(item.expiryDate)}</td>
                  <td className="td tnum text-right">{item.quantity}</td>
                  <td className="td tnum text-right">{money(item.unitPrice)}</td>
                  <td className="td tnum text-right font-medium text-slate-900">
                    {money(item.subtotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Payment</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Subtotal" value={money(sale.subtotal)} />
              {sale.discount > 0 ? (
                <Row
                  label={
                    sale.discountPercent > 0
                      ? `Discount (${sale.discountPercent}%)`
                      : "Discount"
                  }
                  value={`− ${money(sale.discount)}`}
                />
              ) : null}
              <Row label="Taxable" value={money(sale.taxableAmount)} />
              <Row
                label={`VAT @ ${Math.round(sale.vatRate * 100)}%`}
                value={money(sale.vatAmount)}
              />
              <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                <dt className="font-medium text-slate-900">Total</dt>
                <dd className="tnum text-xl font-bold text-slate-900">
                  {money(sale.totalAmount)}
                </dd>
              </div>
            </dl>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <Badge tone={voided ? "slate" : "brand"}>
                Paid by{" "}
                {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ??
                  sale.paymentMode}
              </Badge>
              {voided ? <Badge tone="rose">Voided</Badge> : null}
            </div>
          </Card>

          {canVoid ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Correction</h2>
              <p className="mt-1 mb-3 text-xs text-slate-600">
                Rang up in error, or returned in full before leaving the counter.
              </p>
              <VoidSaleAction
                saleId={String(sale._id)}
                billNo={sale.billNo}
                units={units}
              />
            </Card>
          ) : null}

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Details</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Customer" value={sale.customerName || "Walk-in"} />
              <Row label="Cashier" value={sale.soldByName || "—"} />
              <Row label="Branch" value={sale.branchName || "—"} />
            </dl>
            {sale.note ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {sale.note}
              </p>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tnum text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
