import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { formatDateTime, formatExpiry, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { storedBillNo } from "@/models/Counter";
import { Sale, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { remainingQuantity } from "@/lib/sale-return";
import { formatUnitCount, resolveUnitsPerStrip } from "@/lib/pack";
import { Medicine } from "@/models/Medicine";
import { ReturnSaleForm } from "@/components/sales/ReturnSaleForm";
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
      objectIdSchema.safeParse(id).success
        ? { _id: id, ...pharmacyFilter(session) }
        : { billNo: storedBillNo(id), ...pharmacyFilter(session) },
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
  const returnedUnits = sale.returnedUnits ?? 0;
  const voided = Boolean(sale.voidedAt);
  const catalogue = await Medicine.find({
    _id: { $in: sale.items.map((item) => item.medicineId) },
    ...pharmacyFilter(session),
  })
    .select("unit packSize unitsPerStrip")
    .lean();
  const packById = new Map(catalogue.map((doc) => [String(doc._id), doc]));
  const returnLines = sale.items.map((item, lineIndex) => {
    const pack = packById.get(String(item.medicineId));
    const unit = item.unit || pack?.unit || "unit";
    return {
      lineIndex,
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      quantity: item.quantity,
      remaining: remainingQuantity({
        quantity: item.quantity,
        returnedQuantity: item.returnedQuantity ?? 0,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        unitCost: item.unitCost ?? 0,
        lineCost: item.lineCost ?? 0,
        medicineId: String(item.medicineId),
        medicineName: item.medicineName,
        batchId: String(item.batchId),
        batchNumber: item.batchNumber,
      }),
      unitPrice: item.unitPrice,
      unit,
      unitsPerStrip: resolveUnitsPerStrip(
        unit,
        pack?.packSize ?? "",
        pack?.unitsPerStrip,
      ),
    };
  });
  const canReturn =
    !voided &&
    can(session.role, "sale:void") &&
    returnLines.some((line) => line.remaining > 0);
  const canVoid = !voided && returnedUnits === 0 && can(session.role, "sale:void");
  const returns = sale.returns ?? [];

  return (
    <>
      <PageHeader
        title={sale.billNo}
        subtitle={`${formatDateTime(sale.createdAt as unknown as Date)} · ${units} item${units === 1 ? "" : "s"} · ${sale.items.length} line${sale.items.length === 1 ? "" : "s"}`}
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

      {returnedUnits > 0 ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-amber-900">
            {returnedUnits} item{returnedUnits === 1 ? "" : "s"} returned
            {sale.returnedTotal
              ? ` · refund ${money(sale.returnedTotal)}`
              : ""}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Stock went back onto the original batches. The bill stays on the
            register with the return recorded on it.
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
                <th className="th text-right">Returned</th>
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
                  <td className="td tnum text-right">
                    {formatUnitCount(item.quantity, item.unit || "unit")}
                  </td>
                  <td className="td tnum text-right text-amber-800">
                    {item.returnedQuantity
                      ? formatUnitCount(item.returnedQuantity, item.unit || "unit")
                      : "—"}
                  </td>
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
              {returnedUnits > 0 ? (
                <Badge tone="amber">
                  {returnedUnits >= units ? "Fully returned" : "Partial return"}
                </Badge>
              ) : null}
            </div>
            {sale.returnedTotal ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
                Net collected {money(sale.totalAmount - sale.returnedTotal)} after
                returns.
              </p>
            ) : null}
          </Card>

          {canReturn ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Customer return</h2>
              <p className="mt-1 mb-3 text-xs text-slate-600">
                Put sold medicine back on the shelf — even part of a strip.
                The bill stays; the return shows on this sale.
              </p>
              <ReturnSaleForm
                saleId={String(sale._id)}
                billNo={sale.billNo}
                lines={returnLines}
              />
            </Card>
          ) : null}

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

          {returns.length > 0 ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Returns</h2>
              <ul className="mt-3 space-y-3">
                {returns.map((entry, index) => (
                  <li
                    key={`${String(entry.returnedAt)}-${index}`}
                    className="border-t border-slate-100 pt-3 first:border-0 first:pt-0"
                  >
                    <p className="text-xs font-medium text-slate-900">
                      {entry.units} item{entry.units === 1 ? "" : "s"} ·{" "}
                      {money(entry.totalAmount)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {formatDateTime(entry.returnedAt as unknown as Date)}
                      {entry.returnedByName ? ` · ${entry.returnedByName}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{entry.reason}</p>
                    <ul className="mt-1 text-[11px] text-slate-500">
                      {entry.items.map((item, itemIndex) => (
                        <li key={`${item.batchNumber}-${itemIndex}`}>
                          {item.quantity} {item.medicineName} ({item.batchNumber})
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
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
