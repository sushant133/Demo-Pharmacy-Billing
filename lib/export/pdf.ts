import PDFDocument from "pdfkit";
import { config } from "@/lib/config";
import {
  computeTotals,
  formatCell,
  hasTotals,
  isNumericColumn,
  type ReportColumn,
  type ReportDataset,
} from "@/lib/export/dataset";

/**
 * PDF rendering for report datasets.
 *
 * Deliberately plain: a shop letterhead, a table that repeats its header on
 * every page, and page numbers. This is a document to file or hand to an
 * accountant, not a brochure.
 *
 * Note for Phase 5: PDFKit's built-in Helvetica has no Devanagari coverage, so
 * Nepali output will need an embedded Unicode font (e.g. Noto Sans Devanagari)
 * registered here before any Nepali text can render.
 */

const MARGIN = 36;
const HEADER_FILL = "#0f766e";
const RULE = "#d4d4d8";
const MUTED = "#6b7280";

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: config.timezone,
  }).format(value);
}

/**
 * Distribute the printable width across columns.
 *
 * Text columns get the slack, since numbers are narrow and predictable while a
 * medicine name is what actually needs room.
 */
function columnWidths(columns: ReportColumn[], available: number): number[] {
  const weights = columns.map((column) => {
    if (column.width) return column.width;
    switch (column.type) {
      case "integer":
      case "percent":
        return 8;
      case "money":
      case "number":
        return 11;
      case "date":
        return 12;
      default:
        return 20;
    }
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (weight / totalWeight) * available);
}

export interface PdfOptions {
  /** Landscape suits wide tables; portrait suits narrow ones. */
  landscape?: boolean;
  /**
   * Who the report is from. Passed in rather than read here, because this
   * module renders bytes and knows nothing about databases; the route that
   * already awaited the shop's settings hands them over.
   */
  letterhead?: Letterhead;
}

/** The shop identity printed at the head and foot of every page. */
export interface Letterhead {
  name: string;
  address: string;
  phone: string;
  pan: string;
}

export function toPdfBuffer(
  dataset: ReportDataset,
  options?: PdfOptions,
): Promise<Buffer> {
  // Six or more columns need the extra width to stay legible.
  const landscape = options?.landscape ?? dataset.columns.length > 5;
  const letterhead: Letterhead = options?.letterhead ?? {
    name: config.business.name,
    address: config.business.address,
    phone: config.business.phone,
    pan: config.business.pan,
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: landscape ? "landscape" : "portrait",
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: dataset.title,
        Author: letterhead.name,
        CreationDate: dataset.generatedAt ?? new Date(),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      render(doc, dataset, landscape, letterhead);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function render(
  doc: PDFKit.PDFDocument,
  dataset: ReportDataset,
  landscape: boolean,
  letterhead: Letterhead,
): void {
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const available = right - left;
  const widths = columnWidths(dataset.columns, available);

  // --- Letterhead --------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#111827");
  doc.text(letterhead.name, left, MARGIN);

  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  const addressLine = [letterhead.address, letterhead.phone]
    .filter(Boolean)
    .join("  ·  ");
  if (addressLine) doc.text(addressLine);
  if (letterhead.pan) doc.text(`PAN: ${letterhead.pan}`);

  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827");
  doc.text(dataset.title);

  if (dataset.subtitle) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text(dataset.subtitle);
  }

  // --- Meta block --------------------------------------------------------
  if (dataset.meta && dataset.meta.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(8.5);
    for (const entry of dataset.meta) {
      doc.fillColor(MUTED).text(`${entry.label}: `, { continued: true });
      doc.fillColor("#111827").font("Helvetica-Bold").text(entry.value);
      doc.font("Helvetica");
    }
  }

  doc.moveDown(0.8);

  // --- Table -------------------------------------------------------------
  const rowHeight = 16;
  const headerHeight = 18;
  const fontSize = landscape ? 8 : 7.5;

  let y = doc.y;

  const drawHeader = () => {
    doc.rect(left, y, available, headerHeight).fill(HEADER_FILL);
    doc.font("Helvetica-Bold").fontSize(fontSize).fillColor("#ffffff");

    let x = left;
    dataset.columns.forEach((column, index) => {
      const width = widths[index]!;
      doc.text(column.header, x + 4, y + 5, {
        width: width - 8,
        align: isNumericColumn(column) ? "right" : "left",
        lineBreak: false,
      });
      x += width;
    });

    y += headerHeight;
    doc.font("Helvetica").fillColor("#111827");
  };

  /** Start a new page when the next row would cross the bottom margin. */
  const ensureSpace = (needed: number) => {
    if (y + needed <= doc.page.height - MARGIN - 18) return;
    doc.addPage();
    y = MARGIN;
    drawHeader();
  };

  drawHeader();

  dataset.rows.forEach((row, rowIndex) => {
    ensureSpace(rowHeight);

    // Zebra striping keeps long tables readable across a wide page.
    if (rowIndex % 2 === 1) {
      doc.rect(left, y, available, rowHeight).fill("#f8fafc");
    }

    doc.font("Helvetica").fontSize(fontSize).fillColor("#111827");

    let x = left;
    dataset.columns.forEach((column, index) => {
      const width = widths[index]!;
      const text = formatCell(row[column.key], column.type, formatDate);
      doc.text(text, x + 4, y + 4.5, {
        width: width - 8,
        align: isNumericColumn(column) ? "right" : "left",
        lineBreak: false,
        ellipsis: true,
      });
      x += width;
    });

    y += rowHeight;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke();
  });

  if (dataset.rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED);
    doc.text("No records for this selection.", left, y + 8, {
      width: available,
      align: "center",
    });
    y += 28;
  }

  // --- Totals ------------------------------------------------------------
  if (hasTotals(dataset) && dataset.rows.length > 0) {
    ensureSpace(rowHeight + 4);
    const totals = computeTotals(dataset);

    doc.rect(left, y, available, rowHeight).fill("#f1f5f9");
    doc.font("Helvetica-Bold").fontSize(fontSize).fillColor("#111827");

    let x = left;
    dataset.columns.forEach((column, index) => {
      const width = widths[index]!;
      const text =
        index === 0
          ? "Total"
          : totals[column.key] === undefined
            ? ""
            : formatCell(
                Math.round(totals[column.key]! * 100) / 100,
                column.type,
                formatDate,
              );

      doc.text(text, x + 4, y + 4.5, {
        width: width - 8,
        align: isNumericColumn(column) ? "right" : "left",
        lineBreak: false,
      });
      x += width;
    });

    y += rowHeight;
  }

  if (dataset.note) {
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(dataset.note, left, y + 12, { width: available });
  }

  // --- Footers -----------------------------------------------------------
  // Written after the fact so "page N of M" knows the real total.
  const range = doc.bufferedPageRange();
  const generated = formatDate(dataset.generatedAt ?? new Date());

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(
      `Generated ${generated} · ${letterhead.name}`,
      MARGIN,
      doc.page.height - MARGIN + 2,
      { width: available / 2, align: "left", lineBreak: false },
    );
    doc.text(
      `Page ${i - range.start + 1} of ${range.count}`,
      MARGIN + available / 2,
      doc.page.height - MARGIN + 2,
      { width: available / 2, align: "right", lineBreak: false },
    );
  }
}

export const PDF_CONTENT_TYPE = "application/pdf";
