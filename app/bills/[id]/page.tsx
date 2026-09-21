import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs, formatBsIso, nepaliFiscalYear } from "@/lib/bs-date";
import { withDbRead } from "@/lib/db";
import { getPrintTemplate, getSettings, printedIssuer } from "@/lib/settings";
import { localParts } from "@/lib/dates";
import { formatDateTime, formatExpiry, money } from "@/lib/format";
import { formatUnitCount } from "@/lib/pack";
import { amountInWords } from "@/lib/money-words";
import { pageRule, receiptVars } from "@/lib/print-templates";
import { displayBillNo } from "@/models/Counter";
import { Sale, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { PrintController } from "@/components/bills/PrintController";
import type {
  BillDocumentProps,
  BillDocumentRow,
  BillDocumentTotal,
} from "@/components/bills/BillDocument";
import type { ThermalReceipt } from "@/lib/receipt-text";

export const metadata: Metadata = { title: "Tax Invoice" };
export const dynamic = "force-dynamic";

/**
 * IRD tax invoice, laid out for whichever printer the shop actually owns.
 *
 * Fields follow VAT Rules 2053 Rule 17 / Schedule 5 as they fit on a
 * pharmacy counter receipt: seller identity + PAN, sequential FY bill
 * number, BS and AD datetime, buyer details, line qty/unit/rate, taxable
 * value, 13% VAT, grand total in figures and words. CBMS live upload is a
 * separate IRD-approved software step and is not this page.
 *
 * The paper is a platform setting - see lib/print-templates.ts - because it
 * describes the machine on the counter. It changes how the bill is laid out
 * and never what it says: every field above is printed by all eight
 * templates, a narrow roll moving batch and expiry onto a sub-line rather
 * than giving them a column.
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
  const [issuer, template] = await Promise.all([
    printedIssuer(settings, sale.branchId, user.pharmacyId),
    getPrintTemplate(user.pharmacyId),
  ]);

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
  // 0 means the till was never told, which is how every bill written before
  // the counter asked for it reads. It is not the same as "paid nothing".
  const received = sale.amountReceived ?? 0;
  const change = received - sale.totalAmount;
  const shownBillNo = displayBillNo(sale.billNo);
  const voided = Boolean(sale.voidedAt);
  const alreadyPrinted = Boolean(sale.printedAt);
  const paymentLabel =
    PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ?? sale.paymentMode;
  const vatNumber =
    settings.vatRegistered && settings.vatNumber && settings.vatNumber !== issuer.pan
      ? settings.vatNumber
      : undefined;

  const meta: BillDocumentRow[] = [
    { label: "Bill no", value: shownBillNo },
    ...(fyLabel ? [{ label: "FY", value: fyLabel }] : []),
    ...(bsLabel ? [{ label: "Date (BS)", value: bsLabel }] : []),
    { label: "Date (AD)", value: formatDateTime(issued) },
    { label: "Payment", value: paymentLabel },
  ];

  const party: BillDocumentRow[] = [
    { label: "Buyer", value: sale.customerName || "Walk-in customer" },
    ...(sale.customerPan ? [{ label: "Buyer PAN", value: sale.customerPan }] : []),
    ...(sale.customerAddress ? [{ label: "", value: sale.customerAddress }] : []),
    ...(sale.customerPhone ? [{ label: "", value: `Tel: ${sale.customerPhone}` }] : []),
  ];

  const totals: BillDocumentTotal[] = [
    { label: "Subtotal", value: money(sale.subtotal) },
    // Naming the percentage saves the customer working backwards from a
    // round number, and saves the counter re-explaining it.
    ...(sale.discount > 0
      ? [
          {
            label:
              sale.discountPercent > 0
                ? `Discount (${sale.discountPercent}%)`
                : "Discount",
            value: `− ${money(sale.discount)}`,
          },
        ]
      : []),
    { label: "Taxable", value: money(sale.taxableAmount) },
    { label: `VAT ${vatPct}%`, value: money(sale.vatAmount) },
    { label: "Grand total", value: money(sale.totalAmount), grand: true },
    // Only printed when the till was actually told what was handed over. A
    // bill claiming "Received 0.00" on a card payment would be worse than
    // saying nothing.
    ...(received > 0
      ? [
          { label: "Received", value: money(received) },
          ...(change > 0.004 ? [{ label: "Change", value: money(change) }] : []),
          ...(change < -0.004
            ? [{ label: "Balance due", value: money(-change) }]
            : []),
        ]
      : []),
  ];

  const document: Omit<BillDocumentProps, "copyLabel"> = {
    templateId: template.id,
    kicker: "कर बीजक / TAX INVOICE",
    issuer: {
      name: issuer.name,
      legalName: settings.legalName || undefined,
      address: issuer.address || undefined,
      phone: issuer.phone || undefined,
      email: settings.email || undefined,
      pan: issuer.pan || undefined,
      vat: vatNumber,
      licence: settings.drugLicenceNo || undefined,
    },
    banner: voided
      ? `VOID — ${formatDateTime(sale.voidedAt as unknown as Date)}${
          sale.voidedByName ? ` · ${sale.voidedByName}` : ""
        }`
      : undefined,
    meta,
    party,
    itemsHeading: "Item",
    items: sale.items.map((item) => ({
      name: item.medicineName,
      batch: item.batchNumber,
      expiry: formatExpiry(item.expiryDate),
      qty: formatUnitCount(item.quantity, item.unit || "unit"),
      rate: money(item.unitPrice),
      amount: money(item.subtotal),
    })),
    totals,
    words: amountInWords(sale.totalAmount),
    note: sale.note ? `Note: ${sale.note}` : undefined,
    footLine: `Cashier: ${sale.soldByName || "—"}${
      sale.branchName ? ` · ${sale.branchName}` : ""
    }`,
    signatureLabel: "Authorised signatory",
    tiny: [settings.billTerms, settings.billFooterNote].filter(
      (line): line is string => Boolean(line),
    ),
  };

  const receipt: ThermalReceipt = {
    shop: issuer.name,
    address: issuer.address || undefined,
    phone: issuer.phone || undefined,
    pan: issuer.pan || undefined,
    vat: vatNumber,
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
    payment: paymentLabel,
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
    received: received > 0 ? money(received) : undefined,
    change: change > 0.004 ? money(change) : undefined,
    balance: received > 0 && change < -0.004 ? money(-change) : undefined,
    words: amountInWords(sale.totalAmount),
    cashier:
      [sale.soldByName, sale.branchName].filter(Boolean).join(" · ") || undefined,
    terms: settings.billTerms || undefined,
    footer: settings.billFooterNote || undefined,
  };

  return (
    <div className="receipt-page" style={receiptVars(template) as CSSProperties}>
      {/*
        `@page` cannot be selected by class, so the paper size cannot live in
        the stylesheet with the rest of the receipt rules. Each printed page
        declares its own.
      */}
      <style>{pageRule(template)}</style>

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
        <p className="no-print receipt-notice border-amber-200 bg-amber-50 text-amber-800">
          No seller PAN is set, and a tax invoice without one is not valid. Add
          it under{" "}
          <Link href="/settings" className="font-medium underline">
            Settings
          </Link>
          , or on the outlet itself if branches file separately.
        </p>
      ) : null}

      <PrintController
        saleId={String(sale._id)}
        autoPrint={query.print === "1"}
        alreadyPrinted={alreadyPrinted}
        reprintCount={sale.reprintCount ?? 0}
        escposColumns={template.escposColumns}
        receipt={receipt}
        document={document}
      />
    </div>
  );
}
