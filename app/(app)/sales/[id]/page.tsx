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
import { saleStatusFor } from "@/lib/sale-status";
import { formatUnitCount, resolveUnitsPerStrip } from "@/lib/pack";
import { Medicine } from "@/models/Medicine";
import { RecordPaymentDialog } from "@/components/sales/RecordPaymentDialog";
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

  /*
    Settlement.

    The badge, the balance and the receipts all come off `saleStatusFor`, which
    is the same rule the sales and invoices lists draw their badges from - so a
    bill that reads "Part paid" in a list cannot read "Paid" when it is opened.
    A bill written before the payment ledger existed carries no `paymentStatus`
    and a meaningless `amountReceived` of 0; that one was settled at the till,
    and showing its full total as received is the honest reading.
  */
  const state = saleStatusFor(sale);
  const legacyPayment = sale.paymentStatus == null;
  const received = legacyPayment ? sale.totalAmount : (sale.amountReceived ?? 0);
  const payments = sale.payments ?? [];
  const canCollect =
    !voided && state.remaining > 0 && can(session.role, "payment:write");

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
            {/*
              A plain anchor, not a Link: this is a file download from the API,
              and routing it through the client router would only navigate away
              from the page. Read-only, so fetching it does not consume a copy
              number the way sending the bill to the printer does.
            */}
            <a
              href={`/api/sales/${String(sale._id)}/invoice`}
              className="btn-secondary"
            >
              Download PDF
            </a>
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

      {/*
        Money still owed gets the same weight as a void or a return, because it
        is the same kind of fact: something about this bill is unfinished, and
        whoever opened it needs to know before they read anything else.
      */}
      {state.remaining > 0 ? (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              {money(state.remaining)} outstanding on this bill
            </p>
            <p className="mt-1 text-xs text-amber-800">
              {money(received)} of {money(sale.totalAmount)} has been received
              {sale.customerName ? ` from ${sale.customerName}` : ""}.
            </p>
          </div>
          {canCollect ? (
            <div className="shrink-0">
              <RecordPaymentDialog
                saleId={String(sale._id)}
                billNo={sale.billNo}
                customerName={sale.customerName || undefined}
                outstanding={state.remaining}
                total={sale.totalAmount}
                received={received}
                label="Record payment"
              />
            </div>
          ) : null}
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

              {/*
                Settlement, below the total rather than beside it: the total is
                what the bill says, and these two are what actually happened to
                it. Hidden on a voided bill, where nothing is owed whatever was
                taken at the till.
              */}
              {!voided ? (
                <div className="space-y-2 border-t border-slate-100 pt-2">
                  <Row label="Received" value={money(received)} />
                  {state.remaining > 0 ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-amber-800">Outstanding</dt>
                      <dd className="tnum text-right font-semibold text-amber-800">
                        {money(state.remaining)}
                      </dd>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </dl>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <Badge tone={state.tone}>{state.label}</Badge>
              <Badge tone="slate">
                {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ??
                  sale.paymentMode}
              </Badge>
              {/*
                `state.label` already says Cancelled or Refunded, so a second
                badge repeating it would only be noise. The one it cannot say
                is how much came back, which is what this adds.
              */}
              {returnedUnits > 0 && !voided ? (
                <Badge tone="amber">
                  {returnedUnits} of {units} returned
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

          {/*
            The receipt ledger.

            Append-only, like the returns below it: money taken at the till is
            the first entry and settling a due adds another, so "how was this
            cleared" stays answerable months later. Shown whenever there is
            either something to list or something still to collect - a bill
            paid in one go at the counter has nothing to add here.
          */}
          {payments.length > 0 || canCollect ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Receipts</h2>

              {payments.length > 0 ? (
                <ul className="mt-3 space-y-3">
                  {payments.map((entry, index) => (
                    <li
                      key={`${String(entry.receivedAt)}-${index}`}
                      className="border-t border-slate-100 pt-3 first:border-0 first:pt-0"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="tnum text-sm font-semibold text-slate-900">
                          {money(entry.amount)}
                        </p>
                        <Badge tone={entry.atTill ? "slate" : "green"}>
                          {entry.atTill ? "At the till" : "Later receipt"}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {PAYMENT_MODE_LABELS[entry.method as PaymentMode] ??
                          entry.method}
                        {" · "}
                        {formatDateTime(entry.receivedAt as unknown as Date)}
                        {entry.receivedByName ? ` · ${entry.receivedByName}` : ""}
                      </p>
                      {entry.reference ? (
                        <p className="mt-1 font-mono text-[11px] text-slate-600">
                          Ref {entry.reference}
                        </p>
                      ) : null}
                      {entry.note ? (
                        <p className="mt-1 text-xs text-slate-600">{entry.note}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-slate-600">
                  Nothing has been received against this bill yet.
                </p>
              )}

              {canCollect ? (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <RecordPaymentDialog
                    saleId={String(sale._id)}
                    billNo={sale.billNo}
                    customerName={sale.customerName || undefined}
                    outstanding={state.remaining}
                    total={sale.totalAmount}
                    received={received}
                    label={`Receive ${money(state.remaining)}`}
                  />
                </div>
              ) : null}
            </Card>
          ) : null}

          {/*
            Returns are recorded on the Returns screen, not here.

            Taking medicine back needs an eligibility check, a reason and the
            counter's confirmation that the goods are still sellable. Keeping a
            second, simpler form on this page would mean two paths to the same
            transaction, and the shorter one would be the one that skipped the
            checks.
          */}
          {canReturn ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">Customer return</h2>
              <p className="mt-1 mb-3 text-xs text-slate-600">
                Put sealed, undamaged medicine from this bill back on the shelf.
                The bill stays as it printed; the return is recorded on it.
              </p>
              <Link
                href={`/sales/returns?q=${encodeURIComponent(sale.billNo)}`}
                className="btn-secondary w-full"
              >
                Record a return
              </Link>
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
