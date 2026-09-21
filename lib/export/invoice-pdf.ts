import PDFDocument from "pdfkit";
import { amountInWords } from "@/lib/money-words";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import {
  hasColumn,
  mmToPt,
  printTemplate,
  type BillColumn,
  type PrintTemplate,
} from "@/lib/print-templates";

/**
 * The tax invoice as a downloadable PDF.
 *
 * `lib/export/pdf.ts` renders report *tables* and knows nothing about a bill;
 * an invoice is a document with a header, a party, a totals block and an
 * amount in words, so it gets its own renderer rather than being forced
 * through a column layout.
 *
 * The page follows the shop's assigned template, the same one its counter
 * prints on - see lib/print-templates.ts. A pharmacy running a 58mm roll gets
 * a 58mm PDF it can send straight back to that roll; one running A4 gets the
 * full six-column page. Handing every shop an A4 file regardless would mean
 * the downloaded copy and the counter copy were different documents.
 *
 * No database access here. Everything is passed in, the same discipline the
 * report renderer follows.
 */

const RULE = "#d7dce3";
const INK = "#0f172a";
const MUTED = "#64748b";

export const INVOICE_CONTENT_TYPE = "application/pdf";

export interface InvoiceIssuer {
  name: string;
  address: string;
  phone: string;
  pan: string;
  vatNumber?: string;
  email?: string;
}

export interface InvoiceBuyer {
  name: string;
  address: string;
  phone: string;
  pan: string;
}

export interface InvoiceItem {
  medicineName: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  subtotal: number;
}

export interface InvoiceData {
  billNo: string;
  issuedAt: Date;
  /** Bikram Sambat date line, already formatted. Blank when unavailable. */
  bsDate: string;
  fiscalYear: string;
  issuer: InvoiceIssuer;
  buyer: InvoiceBuyer;
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  discountPercent: number;
  taxableAmount: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
  amountReceived: number;
  paymentMode: PaymentMode;
  soldByName: string;
  branchName: string;
  note: string;
  terms: string;
  footerNote: string;
  /** A voided bill still prints - the number was issued - but says so. */
  voided: boolean;
  /** Copy number. 0 is the original. */
  reprintCount: number;
}

/** Rupee figure without the currency word; the column header carries that. */
function rs(value: number): string {
  return value.toLocaleString("en-NP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * How tall a continuous roll has to be for this bill.
 *
 * A roll has no page height, but a PDF must declare one. Estimated generously
 * from the line count: an over-long page wastes nothing on a roll printer,
 * which cuts at the end of the print, whereas an under-long one spills onto a
 * second page and gets cut through the middle of the totals.
 */
function rollHeightPt(invoice: InvoiceData): number {
  const fixedMm = 150;
  const perItemMm = 14;
  const termsMm = (invoice.terms.length + invoice.footerNote.length) / 40;
  return mmToPt(fixedMm + invoice.items.length * perItemMm + termsMm);
}

export function toInvoicePdf(
  invoice: InvoiceData,
  templateId?: string | null,
): Promise<Buffer> {
  const template = printTemplate(templateId);

  return new Promise((resolve, reject) => {
    const height =
      template.paperHeightMm === null
        ? rollHeightPt(invoice)
        : mmToPt(template.paperHeightMm);

    const doc = new PDFDocument({
      size: [mmToPt(template.paperWidthMm), height],
      margin: mmToPt(template.marginMm),
      bufferPages: true,
      info: {
        Title: `Tax Invoice ${invoice.billNo}`,
        Author: invoice.issuer.name,
        CreationDate: invoice.issuedAt,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      // A template that asks for a buyer copy and an office copy gets two
      // pages. A roll never does: `copies` is a single blank entry there.
      template.copies.forEach((caption, index) => {
        if (index > 0) doc.addPage();
        if (template.layout === "roll") renderRoll(doc, invoice, template);
        else renderSheet(doc, invoice, template, caption);
      });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Relative widths for everything except the item name, which takes the rest. */
const COLUMN_SHARE: Partial<Record<BillColumn, number>> = {
  index: 0.05,
  batch: 0.13,
  expiry: 0.12,
  qty: 0.1,
  rate: 0.11,
  amount: 0.13,
};

interface LaidOutColumn {
  key: BillColumn;
  x: number;
  width: number;
  right: boolean;
  header: string;
}

const COLUMN_HEADER: Record<BillColumn, string> = {
  index: "#",
  item: "ITEM",
  batch: "BATCH",
  expiry: "EXPIRY",
  qty: "QTY",
  rate: "RATE",
  amount: "AMOUNT",
};

/**
 * Place the template's columns across the page.
 *
 * Everything but the item name has a share of the width; the name gets what
 * is left, because a medicine name is the one field that genuinely varies in
 * length and the one worth giving the slack to.
 */
function layOutColumns(
  template: PrintTemplate,
  left: number,
  width: number,
): LaidOutColumn[] {
  const fixed = template.columns
    .filter((key) => key !== "item")
    .reduce((sum, key) => sum + (COLUMN_SHARE[key] ?? 0), 0);

  let x = left;
  return template.columns.map((key) => {
    const share = key === "item" ? Math.max(0.2, 1 - fixed) : (COLUMN_SHARE[key] ?? 0.1);
    const columnWidth = width * share;
    const column: LaidOutColumn = {
      key,
      x,
      width: columnWidth - 4,
      right: key === "qty" || key === "rate" || key === "amount",
      header: COLUMN_HEADER[key],
    };
    x += columnWidth;
    return column;
  });
}

function cellText(item: InvoiceItem, key: BillColumn, index: number): string {
  switch (key) {
    case "index":
      return String(index + 1);
    case "item":
      return item.medicineName;
    case "batch":
      return item.batchNumber;
    case "expiry":
      return item.expiryDate;
    case "qty":
      return `${item.quantity} ${item.unit}`;
    case "rate":
      return rs(item.unitPrice);
    case "amount":
      return rs(item.subtotal);
  }
}

/** A4's usable height, which the other sheet sizes are measured against. */
const A4_USABLE_PT = mmToPt(297 - 24);

/** Sheet and tractor paper: a letterhead, real columns, totals on the right. */
function renderSheet(
  doc: PDFKit.PDFDocument,
  invoice: InvoiceData,
  template: PrintTemplate,
  caption: string,
): void {
  const margin = mmToPt(template.marginMm);
  const left = margin;
  const right = doc.page.width - margin;
  const width = right - left;

  /*
    The layout is drawn at A4 and scaled to whatever paper this actually is.
    Set in points and left alone, an A5 invoice runs its totals off the
    bottom and a 5.5-inch tractor form spills a five-line bill onto a second
    form. The scale follows whichever dimension is tighter - a narrow page
    wraps the item names, a short one runs out of room underneath them -
    floored so that no paper ever prints type nobody can read.
  */
  const usableHeight = doc.page.height - margin * 2;
  const scale = Math.max(
    0.7,
    Math.min(1, template.contentWidthMm / 186, usableHeight / A4_USABLE_PT),
  );
  const fs = (points: number): number => points * scale;

  /*
    Room kept below the last item for the totals, the amount in words and the
    signature. A fixed 150pt is a third of an A4 page and most of a 5.5-inch
    tractor form, which is why the short papers used to break after two lines.
  */
  const reserve = Math.min(fs(150), usableHeight * 0.4);

  // --- Header -------------------------------------------------------------
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(fs(16))
    .text(invoice.issuer.name, left, margin);

  doc.font("Helvetica").fontSize(fs(9)).fillColor(MUTED);
  const issuerLines = [
    invoice.issuer.address,
    invoice.issuer.phone ? `Tel: ${invoice.issuer.phone}` : "",
    invoice.issuer.email ?? "",
    `PAN: ${invoice.issuer.pan || "—"}`,
    invoice.issuer.vatNumber ? `VAT: ${invoice.issuer.vatNumber}` : "",
  ].filter(Boolean);
  for (const line of issuerLines) doc.text(line, left, doc.y, { width: width * 0.55 });

  // Title block, right-aligned against the header.
  doc
    .font("Helvetica-Bold")
    .fontSize(fs(13))
    .fillColor(INK)
    .text("TAX INVOICE", left + width * 0.55, margin, {
      width: width * 0.45,
      align: "right",
    });

  doc.font("Helvetica").fontSize(fs(9)).fillColor(MUTED);
  const metaLines = [
    `Invoice no.  ${invoice.billNo}`,
    `Date  ${invoice.issuedAt.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`,
    invoice.bsDate ? `BS  ${invoice.bsDate}` : "",
    invoice.fiscalYear ? `FY  ${invoice.fiscalYear}` : "",
    invoice.branchName ? `Outlet  ${invoice.branchName}` : "",
  ].filter(Boolean);
  for (const line of metaLines) {
    doc.text(line, left + width * 0.55, doc.y, { width: width * 0.45, align: "right" });
  }

  let y = Math.max(doc.y, margin + fs(74)) + fs(14);

  // Which of the two sheets this is, when the template prints both.
  if (caption) {
    doc
      .font("Helvetica-Bold")
      .fontSize(fs(9))
      .fillColor(MUTED)
      .text(caption.toUpperCase(), left, y, { width, align: "center" });
    y = doc.y + 6;
  }

  if (invoice.voided || invoice.reprintCount > 0) {
    const label = invoice.voided
      ? "VOIDED — this bill has been cancelled"
      : `Copy of Original – ${invoice.reprintCount}`;
    doc
      .font("Helvetica-Bold")
      .fontSize(fs(9))
      .fillColor(invoice.voided ? "#be123c" : MUTED)
      .text(label, left, y, { width, align: "center" });
    y = doc.y + 8;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += fs(12);

  // --- Buyer --------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(fs(9)).fillColor(MUTED).text("BILLED TO", left, y);
  y = doc.y + 2;
  doc
    .font("Helvetica")
    .fontSize(fs(10))
    .fillColor(INK)
    .text(invoice.buyer.name || "Walk-in customer", left, y, { width: width * 0.6 });
  y = doc.y;

  const buyerLines = [
    invoice.buyer.address,
    invoice.buyer.phone,
    invoice.buyer.pan ? `PAN: ${invoice.buyer.pan}` : "",
  ].filter(Boolean);
  doc.fontSize(fs(9)).fillColor(MUTED);
  for (const line of buyerLines) {
    doc.text(line, left, y, { width: width * 0.6 });
    y = doc.y;
  }

  y += fs(14);

  // --- Items --------------------------------------------------------------
  const columns = layOutColumns(template, left, width);
  const batch = hasColumn(template, "batch");
  const expiry = hasColumn(template, "expiry");

  function headerRow(at: number): number {
    doc.font("Helvetica-Bold").fontSize(fs(8.5)).fillColor(MUTED);
    for (const column of columns) {
      doc.text(column.header, column.x, at, {
        width: column.width,
        align: column.right ? "right" : "left",
      });
    }
    const next = doc.y + 4;
    doc.moveTo(left, next).lineTo(right, next).lineWidth(0.8).strokeColor(RULE).stroke();
    return next + 6;
  }

  y = headerRow(y);

  doc.font("Helvetica").fontSize(fs(9)).fillColor(INK);
  invoice.items.forEach((item, index) => {
    // Keep the totals block with at least one row; never orphan a header.
    if (y > doc.page.height - margin - reserve) {
      doc.addPage();
      y = headerRow(margin);
      doc.font("Helvetica").fontSize(fs(9)).fillColor(INK);
    }

    const top = y;
    let bottom = y;
    for (const column of columns) {
      doc.fillColor(
        column.key === "batch" || column.key === "expiry" || column.key === "index"
          ? MUTED
          : INK,
      );
      doc.text(cellText(item, column.key, index), column.x, top, {
        width: column.width,
        align: column.right ? "right" : "left",
      });
      bottom = Math.max(bottom, doc.y);
    }

    // Whatever this paper has no column for still has to appear: a batch
    // number missing from a tax invoice is a compliance problem, not a
    // layout preference.
    const spilled = [batch ? "" : item.batchNumber, expiry ? "" : item.expiryDate]
      .filter(Boolean)
      .join(" · ");
    if (spilled) {
      const nameColumn = columns.find((column) => column.key === "item");
      doc.fontSize(fs(8)).fillColor(MUTED).text(spilled, nameColumn?.x ?? left, bottom, {
        width: nameColumn?.width ?? width,
      });
      bottom = doc.y;
      doc.fontSize(fs(9));
    }

    y = bottom + fs(6);
  });

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += fs(10);

  // --- Totals -------------------------------------------------------------
  const labelX = left + width * 0.58;
  const labelW = width * 0.24;
  const valueX = left + width * 0.82;
  const valueW = width * 0.18;

  function totalRow(label: string, value: string, bold = false): void {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? fs(11) : fs(9.5))
      .fillColor(bold ? INK : MUTED)
      .text(label, labelX, y, { width: labelW, align: "right" });
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fillColor(INK)
      .text(value, valueX, y, { width: valueW, align: "right" });
    y = doc.y + fs(4);
  }

  totalRow("Subtotal", rs(invoice.subtotal));
  if (invoice.discount > 0) {
    totalRow(
      invoice.discountPercent > 0
        ? `Discount (${invoice.discountPercent}%)`
        : "Discount",
      `− ${rs(invoice.discount)}`,
    );
    totalRow("Taxable amount", rs(invoice.taxableAmount));
  }
  totalRow(`VAT (${Math.round(invoice.vatRate * 100)}%)`, rs(invoice.vatAmount));

  y += 2;
  doc.moveTo(labelX, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += 6;
  totalRow("Grand total", `Rs ${rs(invoice.totalAmount)}`, true);

  if (invoice.amountReceived > 0) {
    totalRow("Received", rs(invoice.amountReceived));
    const balance = invoice.totalAmount - invoice.amountReceived;
    if (balance > 0.004) totalRow("Balance due", rs(balance));
    else if (balance < -0.004) totalRow("Change given", rs(-balance));
  }

  y += 6;

  // --- Amount in words, payment, signature --------------------------------
  doc.font("Helvetica-Bold").fontSize(fs(8.5)).fillColor(MUTED).text("IN WORDS", left, y);
  doc
    .font("Helvetica")
    .fontSize(fs(9))
    .fillColor(INK)
    .text(amountInWords(invoice.totalAmount), left, doc.y + 1, { width: width * 0.55 });
  y = doc.y + 8;

  doc.fontSize(fs(9)).fillColor(MUTED);
  doc.text(
    `Payment: ${PAYMENT_MODE_LABELS[invoice.paymentMode] ?? invoice.paymentMode}` +
      (invoice.soldByName ? `   ·   Billed by: ${invoice.soldByName}` : ""),
    left,
    y,
    { width: width * 0.6 },
  );
  y = doc.y;

  if (invoice.note) {
    doc.text(`Note: ${invoice.note}`, left, y, { width: width * 0.6 });
    y = doc.y;
  }

  if (template.showSignature) {
    y += fs(28);
    doc.moveTo(right - width * 0.28, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
    doc
      .fontSize(fs(8.5))
      .fillColor(MUTED)
      .text("Authorised signature", right - width * 0.28, y + 3, {
        width: width * 0.28,
        align: "center",
      });
  }

  // --- Footer -------------------------------------------------------------
  const footerY = doc.page.height - margin - fs(34);
  if (y + fs(16) < footerY) {
    doc.fontSize(fs(7.5)).fillColor(MUTED);
    if (invoice.terms) {
      doc.text(invoice.terms, left, footerY, { width, align: "center" });
    }
    if (invoice.footerNote) {
      doc.text(invoice.footerNote, left, doc.y + 2, { width, align: "center" });
    }
  }
}

/**
 * Roll paper: one narrow column, the same fields, nothing side by side.
 *
 * 54mm of paper cannot hold six columns, so the layout is the one a till
 * roll has always used - label on the left, figure on the right, the batch
 * and expiry on a sub-line under the medicine name.
 */
function renderRoll(
  doc: PDFKit.PDFDocument,
  invoice: InvoiceData,
  template: PrintTemplate,
): void {
  const margin = mmToPt(template.marginMm);
  const left = margin;
  const right = doc.page.width - margin;
  const width = right - left;
  const base = 7.5;

  let y = margin;

  function centre(text: string, size: number, bold = false): void {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .fillColor(INK)
      .text(text, left, y, { width, align: "center" });
    y = doc.y;
  }

  function pair(label: string, value: string, bold = false): void {
    const top = y;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? base + 1.5 : base)
      .fillColor(bold ? INK : MUTED)
      .text(label, left, top, { width: width * 0.52 });
    const bottom = doc.y;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fillColor(INK)
      .text(value, left + width * 0.52, top, { width: width * 0.48, align: "right" });
    y = Math.max(bottom, doc.y) + 1;
  }

  function rule(): void {
    y += 3;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
    y += 4;
  }

  centre("TAX INVOICE", base);
  centre(invoice.issuer.name.toUpperCase(), base + 3, true);
  for (const line of [
    invoice.issuer.address,
    invoice.issuer.phone ? `Tel: ${invoice.issuer.phone}` : "",
    `PAN: ${invoice.issuer.pan || "—"}`,
    invoice.issuer.vatNumber ? `VAT: ${invoice.issuer.vatNumber}` : "",
  ].filter(Boolean)) {
    centre(line, base);
  }

  rule();
  if (invoice.voided) centre("VOIDED — THIS BILL HAS BEEN CANCELLED", base, true);
  else if (invoice.reprintCount > 0) {
    centre(`Copy of Original – ${invoice.reprintCount}`, base, true);
  } else centre("ORIGINAL", base, true);
  rule();

  pair("Bill no", invoice.billNo);
  if (invoice.fiscalYear) pair("FY", invoice.fiscalYear);
  if (invoice.bsDate) pair("Date (BS)", invoice.bsDate);
  pair(
    "Date (AD)",
    invoice.issuedAt.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  pair("Payment", PAYMENT_MODE_LABELS[invoice.paymentMode] ?? invoice.paymentMode);
  rule();

  pair("Buyer", invoice.buyer.name || "Walk-in customer");
  if (invoice.buyer.pan) pair("Buyer PAN", invoice.buyer.pan);
  if (invoice.buyer.phone) pair("Tel", invoice.buyer.phone);
  rule();

  for (const item of invoice.items) {
    doc.font("Helvetica").fontSize(base).fillColor(INK).text(item.medicineName, left, y, {
      width,
    });
    y = doc.y;
    pair(
      `  ${item.quantity} ${item.unit} × ${rs(item.unitPrice)} · ${item.batchNumber}${
        item.expiryDate ? ` · ${item.expiryDate}` : ""
      }`,
      rs(item.subtotal),
    );
  }

  rule();
  pair("Subtotal", rs(invoice.subtotal));
  if (invoice.discount > 0) {
    pair(
      invoice.discountPercent > 0
        ? `Discount (${invoice.discountPercent}%)`
        : "Discount",
      `− ${rs(invoice.discount)}`,
    );
  }
  pair("Taxable", rs(invoice.taxableAmount));
  pair(`VAT ${Math.round(invoice.vatRate * 100)}%`, rs(invoice.vatAmount));
  pair("TOTAL", `Rs ${rs(invoice.totalAmount)}`, true);

  if (invoice.amountReceived > 0) {
    pair("Received", rs(invoice.amountReceived));
    const balance = invoice.totalAmount - invoice.amountReceived;
    if (balance > 0.004) pair("Balance due", rs(balance));
    else if (balance < -0.004) pair("Change", rs(-balance));
  }

  rule();
  doc
    .font("Helvetica-Oblique")
    .fontSize(base - 0.5)
    .fillColor(INK)
    .text(amountInWords(invoice.totalAmount), left, y, { width });
  y = doc.y + 4;

  doc.font("Helvetica").fontSize(base - 0.5).fillColor(MUTED);
  if (invoice.soldByName) {
    doc.text(`Cashier: ${invoice.soldByName}`, left, y, { width });
    y = doc.y;
  }
  if (invoice.note) {
    doc.text(`Note: ${invoice.note}`, left, y, { width });
    y = doc.y;
  }
  for (const line of [invoice.terms, invoice.footerNote].filter(Boolean)) {
    doc.text(line, left, y + 3, { width, align: "center" });
    y = doc.y;
  }
}
