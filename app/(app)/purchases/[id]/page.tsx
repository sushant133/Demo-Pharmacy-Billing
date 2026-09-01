import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { formatDate, formatDateTime, formatExpiry, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  PAYMENT_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  type PaymentStatus,
  type PurchaseStatus,
  type SupplierPaymentMethod,
} from "@/lib/constants";
import { Purchase } from "@/models/Purchase";
import { SupplierPayment } from "@/models/SupplierPayment";
import { objectIdSchema } from "@/lib/validation";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";
import { PurchaseActions } from "@/components/purchases/PurchaseActions";

export const metadata: Metadata = { title: "Purchase" };
export const dynamic = "force-dynamic";

/**
 * One GRN in full: what arrived, what it cost, which batches it created, and
 * what is still owed on it.
 */
export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePagePermission("purchase:read");
  const { id } = await params;

  const { purchase, payments } = await withDbRead(async () => {
    const purchase = await Purchase.findOne(
      objectIdSchema.safeParse(id).success ? { _id: id } : { grnNo: id.toUpperCase() },
    ).lean();

    if (!purchase) notFound();
    const scope = await resolveViewScope(user);
    try {
      assertVisibleInScope(purchase.branchId, scope);
    } catch {
      notFound();
    }

    const payments = await SupplierPayment.find({ purchaseId: purchase._id })
      .sort({ paidOn: -1 })
      .lean();

    return { purchase, payments };
  });

  const units = purchase.items.reduce(
    (sum, item) => sum + item.quantity + item.freeQuantity,
    0,
  );
  const outstanding = Math.round((purchase.totalAmount - purchase.amountPaid) * 100) / 100;
  const overdue =
    purchase.status === "posted" &&
    purchase.paymentStatus !== "paid" &&
    purchase.dueDate &&
    new Date(purchase.dueDate).getTime() < Date.now();

  return (
    <>
      <PageHeader
        title={purchase.grnNo}
        subtitle={`${purchase.supplierName} · received ${formatDate(purchase.receivedDate)} · ${integer(units)} units`}
        actions={
          <>
            <Link href="/purchases" className="btn-secondary">
              Back
            </Link>
            <Link
              href={`/suppliers/${String(purchase.supplierId)}`}
              className="btn-secondary"
            >
              View supplier
            </Link>
          </>
        }
      />

      {purchase.status === "draft" ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
            />
          </svg>
          <span>
            This is still a <strong>draft</strong> — none of this stock exists yet and
            it cannot be sold. Post it once the delivery has been checked against
            the invoice.
          </span>
        </div>
      ) : null}

      {purchase.status === "cancelled" ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <strong>Cancelled</strong> on {formatDateTime(purchase.cancelledAt)} — the
          stock it created has been reversed.
          {purchase.cancelReason ? (
            <span className="mt-1 block text-xs">Reason: {purchase.cancelReason}</span>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            Items received
          </h2>

          <TableWrap>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Medicine</th>
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Free</th>
                <th className="th text-right">Cost</th>
                <th className="th text-right">Eff. cost</th>
                <th className="th text-right">MRP</th>
                <th className="th text-right">Line</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {purchase.items.map((item, index) => (
                <tr key={`${item.batchNumber}-${index}`}>
                  <td className="td">
                    <p className="font-medium text-slate-900">{item.medicineName}</p>
                    {item.batchId ? (
                      <Link
                        href={`/batches?q=${encodeURIComponent(item.batchNumber)}`}
                        className="text-xs text-brand-700 hover:underline"
                      >
                        {item.toppedUpExisting ? "Topped up existing lot" : "View batch"}
                      </Link>
                    ) : null}
                  </td>
                  <td className="td font-mono text-xs text-slate-700">
                    {item.batchNumber}
                  </td>
                  <td className="td text-slate-600">{formatExpiry(item.expiryDate)}</td>
                  <td className="td tnum text-right">{integer(item.quantity)}</td>
                  <td className="td tnum text-right">
                    {item.freeQuantity > 0 ? (
                      <Badge tone="green">+{item.freeQuantity}</Badge>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="td tnum text-right text-slate-600">
                    {money(item.costPrice)}
                  </td>
                  <td className="td tnum text-right text-slate-900">
                    {money(item.effectiveUnitCost)}
                  </td>
                  <td className="td tnum text-right text-slate-600">
                    {money(item.salePrice)}
                  </td>
                  <td className="td tnum text-right font-medium text-slate-900">
                    {money(item.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Badge
                tone={
                  purchase.status === "posted"
                    ? "green"
                    : purchase.status === "draft"
                      ? "amber"
                      : "rose"
                }
              >
                {PURCHASE_STATUS_LABELS[purchase.status as PurchaseStatus]}
              </Badge>
              {purchase.status === "posted" ? (
                <Badge
                  tone={
                    purchase.paymentStatus === "paid"
                      ? "green"
                      : overdue
                        ? "rose"
                        : "slate"
                  }
                >
                  {overdue
                    ? "Overdue"
                    : PAYMENT_STATUS_LABELS[purchase.paymentStatus as PaymentStatus]}
                </Badge>
              ) : null}
            </div>

            <dl className="space-y-2 text-sm">
              <Row label="Subtotal" value={money(purchase.subtotal)} />
              {purchase.discount > 0 ? (
                <Row label="Discount" value={`− ${money(purchase.discount)}`} />
              ) : null}
              {purchase.otherCharges > 0 ? (
                <Row label="Other charges" value={money(purchase.otherCharges)} />
              ) : null}
              <Row label="Taxable" value={money(purchase.taxableAmount)} />
              <Row
                label={`VAT @ ${Math.round(purchase.vatRate * 100)}%`}
                value={money(purchase.vatAmount)}
              />
              <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                <dt className="font-medium text-slate-900">Total</dt>
                <dd className="tnum text-xl font-bold text-slate-900">
                  {money(purchase.totalAmount)}
                </dd>
              </div>
              {purchase.status === "posted" ? (
                <>
                  <Row label="Paid" value={money(purchase.amountPaid)} />
                  <Row
                    label="Outstanding"
                    value={money(outstanding)}
                    className={outstanding > 0 ? "text-rose-600" : "text-emerald-700"}
                  />
                </>
              ) : null}
            </dl>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Details</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Supplier" value={purchase.supplierName} />
              <Row label="Their invoice" value={purchase.invoiceNo || "—"} />
              <Row label="Invoice date" value={formatDate(purchase.invoiceDate)} />
              <Row label="Received" value={formatDate(purchase.receivedDate)} />
              {purchase.dueDate ? (
                <Row label="Payment due" value={formatDate(purchase.dueDate)} />
              ) : null}
              <Row label="Entered by" value={purchase.createdByName || "—"} />
              {purchase.postedAt ? (
                <Row label="Posted" value={formatDateTime(purchase.postedAt)} />
              ) : null}
            </dl>
            {purchase.notes ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {purchase.notes}
              </p>
            ) : null}
          </Card>

          {payments.length > 0 ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {payments.map((payment) => (
                  <li
                    key={String(payment._id)}
                    className="flex items-center justify-between py-2"
                  >
                    <div>
                      <p className="font-medium text-slate-900">
                        {money(payment.amount)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {
                          SUPPLIER_PAYMENT_METHOD_LABELS[
                            payment.method as SupplierPaymentMethod
                          ]
                        }{" "}
                        · {formatDate(payment.paidOn)}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {purchase.status !== "cancelled" ? (
            <Card className="p-4">
              <PurchaseActions
                purchaseId={String(purchase._id)}
                grnNo={purchase.grnNo}
                status={purchase.status}
                canPost={can(user.role, "purchase:post")}
                canCancel={can(user.role, "purchase:cancel")}
                canEdit={can(user.role, "purchase:write")}
              />
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`tnum text-right font-medium text-slate-900 ${className ?? ""}`}>
        {value}
      </dd>
    </div>
  );
}
