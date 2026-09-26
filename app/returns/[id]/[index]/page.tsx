import type { CSSProperties } from "react";
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
import { pageRule, receiptVars } from "@/lib/print-templates";
import { round2 } from "@/lib/sale-payment";
import { getPrintTemplate, getSettings, printedIssuer } from "@/lib/settings";
import { displayBillNo } from "@/models/Counter";
import { Sale } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { AutoPrint } from "@/components/AutoPrint";
import {
  BillDocument,
  type BillDocumentRow,
  type BillDocumentTotal,
} from "@/components/bills/BillDocument";

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
 * Laid out on the same paper as the shop's bills, through the same
 * `BillDocument`, so it comes off the same printer without anyone changing a
 * setting - whether that printer takes a 58mm roll or A4 sheets.
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
  const [issuer, template] = await Promise.all([
    printedIssuer(settings, sale.branchId, user.pharmacyId),
    getPrintTemplate(user.pharmacyId),
  ]);

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
  const againstBill = displayBillNo(sale.billNo);

  const meta: BillDocumentRow[] = [
    { label: "Return no", value: receiptNo },
    { label: "Against bill", value: againstBill },
    ...(bsLabel ? [{ label: "Date (BS)", value: bsLabel }] : []),
    { label: "Date (AD)", value: formatDateTime(returnedAt) },
  ];

  const party: BillDocumentRow[] = [
    { label: "Customer", value: sale.customerName || "Walk-in customer" },
    ...(sale.customerPhone ? [{ label: "", value: `Tel: ${sale.customerPhone}` }] : []),
    { label: "Reason", value: entry.reason || "—" },
  ];

  const totals: BillDocumentTotal[] = [
    { label: "Value returned", value: money(entry.subtotal) },
    ...(entry.discount > 0
      ? [{ label: "Less discount given", value: `− ${money(entry.discount)}` }]
      : []),
    { label: "Taxable", value: money(entry.taxableAmount) },
    { label: `VAT ${vatPct}%`, value: money(entry.vatAmount) },
    // Part of the value cleared what was still owed on the bill; only the
    // rest was handed back. Older returns carry no split and read as before.
    ...(entry.refundPaid != null && entry.refundPaid < entry.totalAmount
      ? [
          { label: "Return value", value: money(entry.totalAmount) },
          {
            label: "Off balance owed",
            value: `− ${money(round2(entry.totalAmount - entry.refundPaid))}`,
          },
          { label: "Refunded", value: money(entry.refundPaid), grand: true },
        ]
      : [{ label: "Refunded", value: money(entry.totalAmount), grand: true }]),
  ];

  return (
    <div className="receipt-page" style={receiptVars(template) as CSSProperties}>
      <style>{pageRule(template)}</style>

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

      <BillDocument
        templateId={template.id}
        kicker="फिर्ता बिल / RETURN RECEIPT"
        issuer={{
          name: issuer.name,
          address: issuer.address || undefined,
          phone: issuer.phone || undefined,
          pan: issuer.pan || undefined,
        }}
        copyLabel="CREDIT NOTE"
        meta={meta}
        party={party}
        itemsHeading="Item returned"
        items={entry.items.map((item) => {
          const original = sale.items[item.lineIndex];
          return {
            name: item.medicineName,
            batch: item.batchNumber,
            expiry: original?.expiryDate
              ? formatExpiry(original.expiryDate as unknown as Date)
              : "",
            qty: formatUnitCount(item.quantity, "unit"),
            rate: money(item.unitPrice),
            amount: money(item.subtotal),
          };
        })}
        totals={totals}
        words={amountInWords(entry.refundPaid ?? entry.totalAmount)}
        /*
          The attestation, printed. It is the counter's record that the goods
          were checked before they went back on a shelf, and the customer's
          copy of the same statement.
        */
        note={
          entry.conditionConfirmed
            ? "Checked as sealed, undamaged and in original packaging; returned to sellable stock."
            : undefined
        }
        footLine={`Received by: ${entry.returnedByName || "—"}${
          sale.branchName ? ` · ${sale.branchName}` : ""
        }`}
        signatureLabel="Customer signature"
        tiny={[
          `This credit note relates to ${againstBill}. The original tax invoice is unchanged.`,
          ...(settings.billFooterNote ? [settings.billFooterNote] : []),
        ]}
      />
    </div>
  );
}
