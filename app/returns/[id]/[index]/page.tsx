import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Types } from "mongoose";
import { requirePageSession } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs, formatBsIso } from "@/lib/bs-date";
import { withDbRead } from "@/lib/db";
import { localParts } from "@/lib/dates";
import { formatDateTime, formatExpiry, money } from "@/lib/format";
import { amountInWords } from "@/lib/money-words";
import { formatUnitCount } from "@/lib/pack";
import { getSettings, printedIssuer } from "@/lib/settings";
import { displayBillNo } from "@/models/Counter";
import { Sale } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { AutoPrint } from "@/components/AutoPrint";

export const metadata: Metadata = { title: "Return receipt" };
export const dynamic = "force-dynamic";

/**
 * The credit note for one return.
 *
 * A return moves money and stock, so it gets a document of its own rather
 * than being a footnote on the original invoice. The invoice stays exactly as
 * it printed - that is the point of recording returns as dated corrections -
 * and this is the piece of paper the customer leaves with.
 *
 * Laid out on the same 80mm roll as a bill, using the same receipt styles, so
 * it comes off the same printer without anyone changing a setting.
 */
export default async function ReturnReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; index: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const [{ id, index }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageSession(`/returns/${id}/${index}`);

  const position = Number(index);
  if (!Types.ObjectId.isValid(id) || !Number.isInteger(position) || position < 0) {
    notFound();
  }

  const sale = await withDbRead(async () => {
    const found = await Sale.findOne({ _id: id, ...pharmacyFilter(user) }).lean();
    if (!found) notFound();

    const scope = await resolveViewScope(user);
    try {
      assertVisibleInScope(found.branchId, scope);
    } catch {
      notFound();
    }
    return found;
  });

  const entry = sale.returns?.[position];
  if (!entry) notFound();

  const settings = await getSettings(user.pharmacyId, user.pharmacyName);
  const issuer = await printedIssuer(settings, sale.branchId, user.pharmacyId);

  const returnedAt = entry.returnedAt as unknown as Date;
  let bsLabel = "";
  try {
    const local = localParts(returnedAt);
    const bs = adToBs(local.year, local.month, local.day);
    bsLabel = `${formatBsIso(bs)} (${formatBs(bs)})`;
  } catch {
    bsLabel = "";
  }

  // Numbered from 1 for a human: "return 2 of 3 against INV-…".
  const receiptNo = `${displayBillNo(sale.billNo)}/R${position + 1}`;
  const vatPct = Math.round((sale.vatRate ?? 0.13) * 100);

  return (
    <div className="receipt-page">
      <div className="no-print receipt-toolbar">
        <Link href="/sales/returns" className="btn-secondary">
          ← Returns
        </Link>
        <div className="flex gap-2">
          <Link href={`/sales/${String(sale._id)}`} className="btn-secondary">
            Original invoice
          </Link>
          <AutoPrint asButton label="Print receipt" />
        </div>
      </div>

      {/*
        Printing a credit note does not consume a copy number the way a bill
        does - there is no "original" to distinguish, because the money has
        already been handed back. So this only opens the print sheet.
      */}
      {query.print === "1" ? <AutoPrint label="Return receipt" /> : null}

      <article className="receipt">
        <header className="receipt-head">
          <p className="receipt-kicker">फिर्ता बिल / RETURN RECEIPT</p>
          <h1 className="receipt-shop">{issuer.name}</h1>
          {issuer.address ? <p>{issuer.address}</p> : null}
          {issuer.phone ? <p>Tel: {issuer.phone}</p> : null}
          <p className="receipt-pan">PAN: {issuer.pan || "—"}</p>
        </header>

        <p className="receipt-copy">CREDIT NOTE</p>

        <dl className="receipt-meta">
          <div>
            <dt>Return no</dt>
            <dd>{receiptNo}</dd>
          </div>
          <div>
            <dt>Against bill</dt>
            <dd>{displayBillNo(sale.billNo)}</dd>
          </div>
          {bsLabel ? (
            <div>
              <dt>Date (BS)</dt>
              <dd>{bsLabel}</dd>
            </div>
          ) : null}
          <div>
            <dt>Date (AD)</dt>
            <dd>{formatDateTime(returnedAt)}</dd>
          </div>
        </dl>

        <section className="receipt-party">
          <p>
            <span className="k">Customer</span>{" "}
            {sale.customerName || "Walk-in customer"}
          </p>
          {sale.customerPhone ? <p>Tel: {sale.customerPhone}</p> : null}
          <p>
            <span className="k">Reason</span> {entry.reason || "—"}
          </p>
        </section>

        <table className="receipt-lines">
          <thead>
            <tr>
              <th className="left">#</th>
              <th className="left">Item returned</th>
              <th className="right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {entry.items.map((item, position) => (
              <tr key={`${String(item.batchId)}-${position}`}>
                <td className="left muted">{position + 1}</td>
                <td className="left">
                  {item.medicineName}
                  <span className="muted block">
                    {formatUnitCount(item.quantity, "unit")} × {money(item.unitPrice)} ·{" "}
                    {item.batchNumber}
                    {sale.items[item.lineIndex]?.expiryDate
                      ? ` · ${formatExpiry(sale.items[item.lineIndex]!.expiryDate as unknown as Date)}`
                      : ""}
                  </span>
                </td>
                <td className="right">{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="receipt-totals">
          <div>
            <dt>Value returned</dt>
            <dd>{money(entry.subtotal)}</dd>
          </div>
          {entry.discount > 0 ? (
            <div>
              <dt>Less discount given</dt>
              <dd>− {money(entry.discount)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Taxable</dt>
            <dd>{money(entry.taxableAmount)}</dd>
          </div>
          <div>
            <dt>VAT {vatPct}%</dt>
            <dd>{money(entry.vatAmount)}</dd>
          </div>
          <div className="grand">
            <dt>Refunded</dt>
            <dd>{money(entry.totalAmount)}</dd>
          </div>
        </dl>

        <p className="receipt-words">{amountInWords(entry.totalAmount)}</p>

        {/*
          The attestation, printed. It is the counter's record that the goods
          were checked before they went back on a shelf, and the customer's
          copy of the same statement.
        */}
        {entry.conditionConfirmed ? (
          <p className="receipt-note">
            Checked as sealed, undamaged and in original packaging; returned to
            sellable stock.
          </p>
        ) : null}

        <footer className="receipt-foot">
          <p>
            Received by: {entry.returnedByName || "—"}
            {sale.branchName ? ` · ${sale.branchName}` : ""}
          </p>
          <p className="sign">Customer signature ________________</p>
          <p className="tiny">
            This credit note relates to {displayBillNo(sale.billNo)}. The
            original tax invoice is unchanged.
          </p>
          {settings.billFooterNote ? (
            <p className="tiny">{settings.billFooterNote}</p>
          ) : null}
        </footer>
      </article>
    </div>
  );
}
