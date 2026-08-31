import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { toDateInputValue } from "@/lib/dates";
import { formatDate, integer, money } from "@/lib/format";
import { round2 } from "@/lib/purchase-math";
import { can } from "@/lib/roles";
import { getSupplierBalance } from "@/lib/suppliers";
import {
  PAYMENT_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  type PaymentStatus,
  type PurchaseStatus,
  type SupplierPaymentMethod,
} from "@/lib/constants";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import { objectIdSchema } from "@/lib/validation";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";
import { SupplierFormPanel } from "@/components/suppliers/SupplierFormPanel";
import { PaymentFormPanel } from "@/components/suppliers/PaymentFormPanel";

export const metadata: Metadata = { title: "Supplier" };
export const dynamic = "force-dynamic";

/** One supplier: their details, purchase history and payment ledger. */
export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string; pay?: string; invoice?: string }>;
}) {
  const user = await requirePagePermission("supplier:read");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  await connectDB();

  const parsed = objectIdSchema.safeParse(id);
  if (!parsed.success) notFound();

  const supplier = await Supplier.findById(parsed.data).lean();
  if (!supplier) notFound();

  const [balance, purchases, payments] = await Promise.all([
    getSupplierBalance(parsed.data),
    Purchase.find({ supplierId: supplier._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    SupplierPayment.find({ supplierId: supplier._id })
      .sort({ paidOn: -1, createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const canWrite = can(user.role, "supplier:write");
  const canPay = can(user.role, "payment:write");

  // Only posted, not-fully-paid invoices can receive a payment.
  const openInvoices = purchases
    .filter(
      (purchase) => purchase.status === "posted" && purchase.paymentStatus !== "paid",
    )
    .map((purchase) => ({
      id: String(purchase._id),
      grnNo: purchase.grnNo,
      outstanding: round2(purchase.totalAmount - purchase.amountPaid),
    }));

  const now = Date.now();

  return (
    <>
      <PageHeader
        title={supplier.name}
        subtitle={
          [supplier.contactPerson, supplier.phone, supplier.address]
            .filter(Boolean)
            .join(" · ") || "No contact details recorded"
        }
        actions={
          <>
            <Link href="/suppliers" className="btn-secondary">
              Back
            </Link>
            {canWrite ? (
              <Link
                href={`/suppliers/${parsed.data}?edit=1`}
                className="btn-secondary"
              >
                Edit
              </Link>
            ) : null}
            {canPay && balance.outstanding > 0 ? (
              <Link href={`/suppliers/${parsed.data}?pay=1`} className="btn-primary">
                Record payment
              </Link>
            ) : null}
          </>
        }
      />

      {supplier.isActive === false ? (
        <div className="mb-4 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-sm text-slate-700">
          This supplier is <strong>inactive</strong> — their history is intact, but
          new purchases from them are blocked.
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={money(balance.outstanding)}
          hint={
            balance.openingBalance !== 0
              ? `Includes ${money(balance.openingBalance)} opening`
              : undefined
          }
          tone={balance.outstanding > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Overdue"
          value={money(balance.overdueAmount)}
          tone={balance.overdueAmount > 0 ? "danger" : "default"}
        />
        <StatCard label="Total purchased" value={money(balance.purchased)} />
        <StatCard
          label="Purchases"
          value={integer(balance.postedPurchaseCount)}
          hint={`${balance.unpaidInvoiceCount} unsettled`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Purchase history</h2>
            <Link
              href={`/purchases?supplierId=${parsed.data}`}
              className="text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              View all
            </Link>
          </div>

          {purchases.length === 0 ? (
            <EmptyState
              title="No purchases yet"
              description="Deliveries recorded against this supplier will appear here."
              action={
                can(user.role, "purchase:write") ? (
                  <Link href="/purchases/new" className="btn-primary">
                    New purchase
                  </Link>
                ) : null
              }
            />
          ) : (
            <TableWrap>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">GRN</th>
                  <th className="th">Received</th>
                  <th className="th">Due</th>
                  <th className="th text-right">Total</th>
                  <th className="th text-right">Owed</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {purchases.map((purchase) => {
                  const owed = round2(purchase.totalAmount - purchase.amountPaid);
                  const overdue =
                    purchase.status === "posted" &&
                    purchase.paymentStatus !== "paid" &&
                    purchase.dueDate &&
                    new Date(purchase.dueDate).getTime() < now;

                  return (
                    <tr key={String(purchase._id)} className="hover:bg-slate-50">
                      <td className="td">
                        <Link
                          href={`/purchases/${String(purchase._id)}`}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {purchase.grnNo}
                        </Link>
                      </td>
                      <td className="td whitespace-nowrap text-slate-600">
                        {formatDate(purchase.receivedDate)}
                      </td>
                      <td className="td whitespace-nowrap text-slate-600">
                        {purchase.dueDate ? formatDate(purchase.dueDate) : "—"}
                      </td>
                      <td className="td tnum text-right">{money(purchase.totalAmount)}</td>
                      <td className="td tnum text-right">
                        {purchase.status === "posted" && owed > 0 ? (
                          <span className="font-semibold text-rose-600">
                            {money(owed)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="td">
                        <Badge
                          tone={
                            purchase.status === "cancelled"
                              ? "rose"
                              : purchase.status === "draft"
                                ? "amber"
                                : purchase.paymentStatus === "paid"
                                  ? "green"
                                  : overdue
                                    ? "rose"
                                    : "slate"
                          }
                        >
                          {purchase.status === "posted"
                            ? overdue
                              ? "Overdue"
                              : PAYMENT_STATUS_LABELS[
                                  purchase.paymentStatus as PaymentStatus
                                ]
                            : PURCHASE_STATUS_LABELS[purchase.status as PurchaseStatus]}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Details</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Contact" value={supplier.contactPerson || "—"} />
              <Row label="Phone" value={supplier.phone || "—"} />
              <Row label="Email" value={supplier.email || "—"} />
              <Row label="PAN / VAT" value={supplier.panNo || "—"} />
              <Row
                label="Credit period"
                value={
                  supplier.paymentTermsDays
                    ? `${supplier.paymentTermsDays} days`
                    : "Immediate"
                }
              />
              <Row label="Opening balance" value={money(supplier.openingBalance ?? 0)} />
            </dl>
            {supplier.notes ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {supplier.notes}
              </p>
            ) : null}
          </Card>

          <Card className="overflow-hidden">
            <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
              Payments
            </h2>
            {payments.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                Nothing paid yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {payments.map((payment) => (
                  <li key={String(payment._id)} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="tnum font-medium text-slate-900">
                        {money(payment.amount)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {formatDate(payment.paidOn)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {
                        SUPPLIER_PAYMENT_METHOD_LABELS[
                          payment.method as SupplierPaymentMethod
                        ]
                      }
                      {payment.grnNo ? ` · ${payment.grnNo}` : " · on account"}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {canWrite && query.edit === "1" ? (
        <SupplierFormPanel
          canDelete={can(user.role, "supplier:delete")}
          returnTo={`/suppliers/${parsed.data}`}
          supplier={{
            id: parsed.data,
            name: supplier.name,
            contactPerson: supplier.contactPerson ?? "",
            phone: supplier.phone ?? "",
            email: supplier.email ?? "",
            address: supplier.address ?? "",
            panNo: supplier.panNo ?? "",
            paymentTermsDays: supplier.paymentTermsDays ?? 0,
            openingBalance: supplier.openingBalance ?? 0,
            notes: supplier.notes ?? "",
            isActive: supplier.isActive !== false,
          }}
        />
      ) : null}

      {canPay && query.pay === "1" ? (
        <PaymentFormPanel
          supplierId={parsed.data}
          supplierName={supplier.name}
          outstanding={balance.outstanding}
          openInvoices={openInvoices}
          today={toDateInputValue()}
          presetInvoiceId={query.invoice}
        />
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
