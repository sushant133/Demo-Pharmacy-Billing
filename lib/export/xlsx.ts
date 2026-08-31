import ExcelJS from "exceljs";
import {
  computeTotals,
  hasTotals,
  isNumericColumn,
  type ReportColumn,
  type ReportDataset,
} from "@/lib/export/dataset";

/**
 * Excel (.xlsx) rendering.
 *
 * A real workbook rather than a renamed CSV: numbers stay numeric with rupee
 * and percentage formats attached, dates stay dates, the header row freezes,
 * and an autofilter is set - so the accountant can sort and pivot without
 * re-typing anything.
 */

/** Excel number formats per column type. */
const NUMBER_FORMAT: Record<string, string> = {
  money: '#,##0.00;[Red]-#,##0.00',
  number: "#,##0.00",
  integer: "#,##0",
  percent: '0.0"%"',
  date: "dd mmm yyyy",
};

function excelWidth(column: ReportColumn): number {
  if (column.width) return column.width;
  // Roughly fit the header, with a floor that suits most data columns.
  return Math.max(12, Math.min(40, column.header.length + 4));
}

export async function toXlsxBuffer(dataset: ReportDataset): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MantraPharma";
  workbook.created = dataset.generatedAt ?? new Date();

  // Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars.
  const sheetName = dataset.title.replace(/[:\\/?*[\]]/g, "").slice(0, 31) || "Report";
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 0 }],
  });

  // --- Title block -------------------------------------------------------
  const lastColumn = dataset.columns.length;

  const titleRow = sheet.addRow([dataset.title]);
  titleRow.font = { bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, lastColumn);

  if (dataset.subtitle) {
    const subtitleRow = sheet.addRow([dataset.subtitle]);
    subtitleRow.font = { size: 10, color: { argb: "FF6B7280" } };
    sheet.mergeCells(subtitleRow.number, 1, subtitleRow.number, lastColumn);
  }

  for (const entry of dataset.meta ?? []) {
    const row = sheet.addRow([entry.label, entry.value]);
    row.getCell(1).font = { size: 10, color: { argb: "FF6B7280" } };
    row.getCell(2).font = { size: 10, bold: true };
  }

  sheet.addRow([]);

  // --- Header row --------------------------------------------------------
  const headerRow = sheet.addRow(dataset.columns.map((column) => column.header));
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 20;
  headerRow.eachCell((cell, index) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F766E" }, // brand teal, matching the UI
    };
    const column = dataset.columns[index - 1];
    if (column && isNumericColumn(column)) {
      cell.alignment = { horizontal: "right", vertical: "middle" };
    }
  });

  const headerRowNumber = headerRow.number;

  // --- Data rows ---------------------------------------------------------
  for (const row of dataset.rows) {
    const values = dataset.columns.map((column) => {
      const value = row[column.key];
      if (value === null || value === undefined) return null;
      // Hand Excel real numbers and dates so formats and sorting work.
      if (value instanceof Date) return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      return value;
    });

    const added = sheet.addRow(values);
    added.eachCell((cell, index) => {
      const column = dataset.columns[index - 1];
      if (!column) return;
      const format = NUMBER_FORMAT[column.type];
      if (format) cell.numFmt = format;
      if (isNumericColumn(column)) cell.alignment = { horizontal: "right" };
    });
  }

  // --- Totals ------------------------------------------------------------
  if (hasTotals(dataset) && dataset.rows.length > 0) {
    const totals = computeTotals(dataset);
    const values = dataset.columns.map((column, index) => {
      if (index === 0) return "Total";
      const value = totals[column.key];
      return value === undefined ? null : Math.round(value * 100) / 100;
    });

    const totalRow = sheet.addRow(values);
    totalRow.font = { bold: true };
    totalRow.eachCell((cell, index) => {
      const column = dataset.columns[index - 1];
      if (!column) return;
      const format = NUMBER_FORMAT[column.type];
      if (format) cell.numFmt = format;
      if (isNumericColumn(column)) cell.alignment = { horizontal: "right" };
      cell.border = { top: { style: "thin", color: { argb: "FF0F766E" } } };
    });
  }

  // --- Column widths, freeze and filter ----------------------------------
  dataset.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = excelWidth(column);
  });

  // Freeze everything above the first data row so headers stay visible.
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];

  if (dataset.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber + dataset.rows.length, column: lastColumn },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
