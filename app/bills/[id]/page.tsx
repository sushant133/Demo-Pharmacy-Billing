import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs, formatBsIso, nepaliFiscalYear } from "@/lib/bs-date";
import { withDbRead } from "@/lib/db";
import { getSettings, printedIssuer } from "@/lib/settings";
import { localParts } from "@/lib/dates";
import { formatDateTime, formatExpiry, money } from "@/lib/format";
import { formatUnitCount } from "@/lib/pack";
import { amountInWords } from "@/lib/money-words";
import { displayBillNo } from "@/models/Counter";
import { Sale, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { PrintController } from "@/components/bills/PrintController";
import type { ThermalReceipt } from "@/lib/receipt-text";

export const metadata: Metadata = { title: "Tax Invoice" };
export const dynamic = "force-dynamic";

/**
 * IRD tax invoice, laid out for an 80mm thermal roll.
 *
 * Fields follow VAT Rules 2053 Rule 17 / Schedule 5 as they fit on a
 * pharmacy counter receipt: seller identity + PAN, sequential FY bill
 * number, BS and AD datetime, buyer details, line qty/unit/rate, taxable
 * value, 13% VAT, grand total in figures and words. CBMS live upload is a
 * separate IRD-approved software step and is not this page.
 */
export default async function BillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageSession(`/bills/${id}`);

  const sale = await withDbRead(async () => {
    const sale = await Sale.findOne(
      objectIdSchema.safeParse(id).success
        ? { _id: id, ...pharmacyFilter(user) }
        : {
            billNo: decodeURIComponent(id).toUpperCase(),
            ...pharmacyFilter(user),
          },
    ).lean();

    if (!sale) notFound();
    const scope = await resolveViewScope(user);
    try {
      assertVisibleInScope(sale.branchId, scope);
    } catch {
      notFound();
    }
    return sale;
  });

  // Settings for a single-shop pharmacy; the issuing outlet's own identity
  // once a second branch is open. See `printedIssuer`.
  const settings = await getSettings(user.pharmacyId, user.pharmacyName);
  const issuer = await printedIssuer(settings, sale.branchId, user.pharmacyId);

  const issued = sale.createdAt as unknown as Date;
  const local = localParts(issued);
  let bsLabel = "";
  let fyLabel = sale.fiscalYear?.replace("-", "/") || "";
  try {
    const bs = adToBs(local.year, local.month, local.day);
    bsLabel = `${formatBsIso(bs)} (${formatBs(bs)})`;
    if (!fyLabel) fyLabel = nepaliFiscalYear(bs).replace("-", "/");
  } catch {
    bsLabel = "";
  }

  const vatPct = Math.round((sale.vatRate ?? 0.13) * 100);
  const shownBillNo = displayBillNo(sale.billNo);
  const voided = Boolean(sale.voidedAt);
  const alreadyPrinted = Boolean(sale.printedAt);

  return (
    <div className="receipt-page">
      <div className="no-print receipt-toolbar">
        <Link href="/billing" className="btn-secondary">
          ← New sale
        </Link>
        <div className="flex gap-2">
          <Link href="/sales" className="btn-secondary">
            All sales
          </Link>
        </div>
      </div>

      {!issuer.pan ? (
        <p className="no-print mx-auto mb-3 max-w-[80mm] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No seller PAN is set, and a tax invoice without one is not valid. Add
          it under{" "}
          <Link href="/settings" className="font-medium underline">
            Settings
          </Link>
          , or on the outlet itself if branches file separately.
        </p>
      ) : null}

      <article className="receipt">
        <header className="receipt-head">
          <p className="receipt-kicker">कर बीजक / TAX INVOICE</p>
          <h1 className="receipt-shop">{issuer.name}</h1>
          {settings.legalName && settings.legalName !== issuer.name ? (
            <p>{settings.legalName}</p>
          ) : null}
          {issuer.address ? <p>{issuer.address}</p> : null}
          {issuer.phone ? <p>Tel: {issuer.phone}</p> : null}
          {settings.email ? <p>{settings.email}</p> : null}
          <p className="receipt-pan">PAN: {issuer.pan || "—"}</p>
          {settings.vatRegistered &&
          settings.vatNumber &&
          settings.vatNumber !== issuer.pan ? (
            <p>VAT: {settings.vatNumber}</p>
          ) : null}
          {settings.drugLicenceNo ? (
            <p>DDA licence: {settings.drugLicenceNo}</p>
          ) : null}
        </header>

        <PrintController
          saleId={String(sale._id)}
          autoPrint={query.print === "1"}
          alreadyPrinted={alreadyPrinted}
          reprintCount={sale.reprintCount ?? 0}
          receipt={
            {
              shop: issuer.name,
              address: issuer.address || undefined,
              phone: issuer.phone || undefined,
              pan: issuer.pan || undefined,
              vat:
                settings.vatRegistered &&
                settings.vatNumber &&
                settings.vatNumber !== issuer.pan
                  ? settings.vatNumber
                  : undefined,
              licence: settings.drugLicenceNo || undefined,
              copyLabel: alreadyPrinted
                ? (sale.reprintCount ?? 0) > 0
                  ? `Copy of Original – ${sale.reprintCount}`
                  : "ORIGINAL"
                : "ORIGINAL",
              billNo: shownBillNo,
              fiscalYear: fyLabel || undefined,
              dateBs: bsLabel || undefined,
              dateAd: formatDateTime(issued),
              payment:
                PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ?? sale.paymentMode,
              buyer: sale.customerName || "Walk-in customer",
              buyerPan: sale.customerPan || undefined,
              items: sale.items.map((item) => ({
                name: item.medicineName,
                detail: `${formatUnitCount(item.quantity, item.unit || "unit")} x ${money(item.unitPrice)} · ${item.batchNumber}`,
                amount: money(item.subtotal),
              })),
              subtotal: money(sale.subtotal),
              discount: sale.discount > 0 ? `− ${money(sale.discount)}` : undefined,
              taxable: money(sale.taxableAmount),
              vatLabel: `VAT ${vatPct}%`,
              vatAmount: money(sale.vatAmount),
              total: money(sale.totalAmount),
              words: amountInWords(sale.totalAmount),
              cashier: [sale.soldByName, sale.branchName].filter(Boolean).join(" · ") || undefined,
              terms: settings.billTerms || undefined,
              footer: settings.billFooterNote || undefined,
            } satisfies ThermalReceipt
          }
        />

        {voided ? (
          <p className="receipt-void">
            VOID — {formatDateTime(sale.voidedAt as unknown as Date)}
            {sale.voidedByName ? ` · ${sale.voidedByName}` : ""}
          </p>
        ) : null}

        <dl className="receipt-meta">
          <div>
            <dt>Bill no</dt>
            <dd>{shownBillNo}</dd>
          </div>
          {fyLabel ? (
            <div>
              <dt>FY</dt>
              <dd>{fyLabel}</dd>
            </div>
          ) : null}
          {bsLabel ? (
            <div>
              <dt>Date (BS)</dt>
              <dd>{bsLabel}</dd>
            </div>
          ) : null}
          <div>
            <dt>Date (AD)</dt>
            <dd>{formatDateTime(issued)}</dd>
          </div>
          <div>
            <dt>Payment</dt>
            <dd>
              {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ?? sale.paymentMode}
            </dd>
          </div>
        </dl>

        <section className="receipt-party">
          <p>
            <span className="k">Buyer</span> {sale.customerName || "Walk-in customer"}
          </p>
          {sale.customerPan ? (
            <p>
              <span className="k">Buyer PAN</span> {sale.customerPan}
            </p>
          ) : null}
          {sale.customerAddress ? <p>{sale.customerAddress}</p> : null}
          {sale.customerPhone ? <p>Tel: {sale.customerPhone}</p> : null}
        </section>

        <table className="receipt-lines">
          <thead>
            <tr>
              <th className="left">#</th>
              <th className="left">Item</th>
              <th className="right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item, index) => (
              <tr key={`${String(item.batchId)}-${index}`}>
                <td className="left muted">{index + 1}</td>
                <td className="left">
                  {item.medicineName}
                  <span className="muted block">
                    {formatUnitCount(item.quantity, item.unit || "unit")} ×{" "}
                    {money(item.unitPrice)} ·{" "}
                    {item.batchNumber} · {formatExpiry(item.expiryDate)}
                  </span>
                </td>
                <td className="right">{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="receipt-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(sale.subtotal)}</dd>
          </div>
          {sale.discount > 0 ? (
            <div>
              {/*
                Naming the percentage saves the customer working backwards from
                a round number, and saves the counter re-explaining it.
              */}
              <dt>
                Discount
                {sale.discountPercent > 0 ? ` (${sale.discountPercent}%)` : ""}
              </dt>
              <dd>− {money(sale.discount)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Taxable</dt>
            <dd>{money(sale.taxableAmount)}</dd>
          </div>
          <div>
            <dt>VAT {vatPct}%</dt>
            <dd>{money(sale.vatAmount)}</dd>
          </div>
          <div className="grand">
            <dt>Grand total</dt>
            <dd>{money(sale.totalAmount)}</dd>
          </div>
        </dl>

        <p className="receipt-words">{amountInWords(sale.totalAmount)}</p>

        {sale.note ? <p className="receipt-note">Note: {sale.note}</p> : null}

        <footer className="receipt-foot">
          <p>
            Cashier: {sale.soldByName || "—"}
            {sale.branchName ? ` · ${sale.branchName}` : ""}
          </p>
          <p className="sign">Authorised signatory ________________</p>
          {settings.billTerms ? <p className="tiny">{settings.billTerms}</p> : null}
          {settings.billFooterNote ? (
            <p className="tiny">{settings.billFooterNote}</p>
          ) : null}
        </footer>
      </article>
    </div>
  );
}


