import PDFDocument from "pdfkit";
import { amountInWords } from "@/lib/money-words";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";

/**
 * The tax invoice as a downloadable PDF.
 *
 * `lib/export/pdf.ts` renders report *tables* and knows nothing about a bill;
 * an invoice is a document with a header, a party, a totals block and an
 * amount in words, so it gets its own renderer rather than being forced
 * through a column layout.
 *
 * A4 rather than the 80mm roll the receipt prints on: the roll is for handing
 * over at the counter, this is the copy a customer files or emails to their
 * accountant. Both carry the same numbers, and both are the same bill.
 *
 * No database access here. Everything is passed in, the same discipline the
 * report renderer follows.
 */

const MARGIN = 48;
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

export function toInvoicePdf(invoice: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
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
      render(doc, invoice);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function render(doc: PDFKit.PDFDocument, invoice: InvoiceData): void {
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;

  // --- Header -------------------------------------------------------------
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(invoice.issuer.name, left, MARGIN);

  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
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
    .fontSize(13)
    .fillColor(INK)
    .text("TAX INVOICE", left + width * 0.55, MARGIN, {
      width: width * 0.45,
      align: "right",
    });

  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
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

  let y = Math.max(doc.y, MARGIN + 74) + 14;

  if (invoice.voided || invoice.reprintCount > 0) {
    const label = invoice.voided
      ? "VOIDED — this bill has been cancelled"
      : `Copy of Original – ${invoice.reprintCount}`;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(invoice.voided ? "#be123c" : MUTED)
      .text(label, left, y, { width, align: "center" });
    y = doc.y + 8;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += 12;

  // --- Buyer --------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("BILLED TO", left, y);
  y = doc.y + 2;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(INK)
    .text(invoice.buyer.name || "Walk-in customer", left, y, { width: width * 0.6 });
  y = doc.y;

  const buyerLines = [
    invoice.buyer.address,
    invoice.buyer.phone,
    invoice.buyer.pan ? `PAN: ${invoice.buyer.pan}` : "",
  ].filter(Boolean);
  doc.fontSize(9).fillColor(MUTED);
  for (const line of buyerLines) {
    doc.text(line, left, y, { width: width * 0.6 });
    y = doc.y;
  }

  y += 14;

  // --- Items --------------------------------------------------------------
  // Fixed columns: an invoice always has the same six, so they are laid out
  // by hand rather than weighted like a report's arbitrary column set.
  const cols = {
    item: left,
    batch: left + width * 0.38,
    expiry: left + width * 0.53,
    qty: left + width * 0.66,
    rate: left + width * 0.76,
    amount: left + width * 0.88,
  };
  const widths = {
    item: width * 0.36,
    batch: width * 0.14,
    expiry: width * 0.12,
    qty: width * 0.09,
    rate: width * 0.11,
    amount: width * 0.12,
  };

  function headerRow(at: number): number {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED);
    doc.text("ITEM", cols.item, at, { width: widths.item });
    doc.text("BATCH", cols.batch, at, { width: widths.batch });
    doc.text("EXPIRY", cols.expiry, at, { width: widths.expiry });
    doc.text("QTY", cols.qty, at, { width: widths.qty, align: "right" });
    doc.text("RATE", cols.rate, at, { width: widths.rate, align: "right" });
    doc.text("AMOUNT", cols.amount, at, { width: widths.amount, align: "right" });
    const next = doc.y + 4;
    doc.moveTo(left, next).lineTo(right, next).lineWidth(0.8).strokeColor(RULE).stroke();
    return next + 6;
  }

  y = headerRow(y);

  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const item of invoice.items) {
    // Keep the totals block with at least one row; never orphan a header.
    if (y > doc.page.height - MARGIN - 150) {
      doc.addPage();
      y = headerRow(MARGIN);
      doc.font("Helvetica").fontSize(9).fillColor(INK);
    }

    const top = y;
    doc.text(item.medicineName, cols.item, top, { width: widths.item });
    const rowBottom = doc.y;

    doc.fillColor(MUTED);
    doc.text(item.batchNumber, cols.batch, top, { width: widths.batch });
    doc.text(item.expiryDate, cols.expiry, top, { width: widths.expiry });
    doc.fillColor(INK);
    doc.text(`${item.quantity} ${item.unit}`, cols.qty, top, {
      width: widths.qty,
      align: "right",
    });
    doc.text(rs(item.unitPrice), cols.rate, top, { width: widths.rate, align: "right" });
    doc.text(rs(item.subtotal), cols.amount, top, {
      width: widths.amount,
      align: "right",
    });

    y = Math.max(rowBottom, doc.y) + 6;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += 10;

  // --- Totals -------------------------------------------------------------
  const labelX = left + width * 0.58;
  const labelW = width * 0.24;
  const valueX = left + width * 0.82;
  const valueW = width * 0.18;

  function totalRow(label: string, value: string, bold = false): void {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? INK : MUTED)
      .text(label, labelX, y, { width: labelW, align: "right" });
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fillColor(INK)
      .text(value, valueX, y, { width: valueW, align: "right" });
    y = doc.y + 4;
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
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED).text("IN WORDS", left, y);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(INK)
    .text(amountInWords(invoice.totalAmount), left, doc.y + 1, { width: width * 0.55 });
  y = doc.y + 8;

  doc.fontSize(9).fillColor(MUTED);
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

  y += 30;
  doc.moveTo(right - width * 0.28, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc
    .fontSize(8.5)
    .fillColor(MUTED)
    .text("Authorised signature", right - width * 0.28, y + 3, {
      width: width * 0.28,
      align: "center",
    });

  // --- Footer -------------------------------------------------------------
  const footerY = doc.page.height - MARGIN - 34;
  if (y + 20 < footerY) {
    doc.fontSize(7.5).fillColor(MUTED);
    if (invoice.terms) {
      doc.text(invoice.terms, left, footerY, { width, align: "center" });
    }
    if (invoice.footerNote) {
      doc.text(invoice.footerNote, left, doc.y + 2, { width, align: "center" });
    }
  }
}
