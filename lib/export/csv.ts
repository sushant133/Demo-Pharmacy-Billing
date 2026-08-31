import {
  computeTotals,
  formatCell,
  hasTotals,
  isNumericColumn,
  type ReportDataset,
} from "@/lib/export/dataset";

/**
 * CSV rendering.
 *
 * Pure and dependency-free, so the escaping rules - which are where CSV
 * exporters actually go wrong - can be tested directly.
 */

/** Cells that Excel and Sheets would otherwise execute as a formula. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Escape one field for CSV.
 *
 * Two separate concerns, both handled here:
 *
 * 1. **RFC 4180 quoting** - a field containing a comma, quote or newline is
 *    wrapped in quotes, and embedded quotes are doubled.
 *
 * 2. **Formula injection** - a spreadsheet treats a leading `=`, `+`, `-` or
 *    `@` as a formula, so a medicine named `=cmd|...` would execute on open.
 *    Such fields are prefixed with a single quote, which spreadsheets read as
 *    "this is text". This matters because export content includes
 *    user-supplied names typed at the counter.
 */
export function escapeCsvField(value: string): string {
  let field = value;

  if (field.length > 0 && FORMULA_PREFIXES.some((prefix) => field.startsWith(prefix))) {
    field = `'${field}`;
  }

  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }

  return field;
}

export interface CsvOptions {
  /** How Date cells are rendered. Defaults to ISO date. */
  formatDate?: (value: Date) => string;
  /** Include the title/meta preamble above the header row. */
  includeHeaderBlock?: boolean;
}

/**
 * Render a dataset as CSV text.
 *
 * Numbers are written unformatted (no thousands separators, no currency
 * symbol) so the file stays machine-readable and Excel parses the columns as
 * numeric rather than text.
 */
export function toCsv(dataset: ReportDataset, options?: CsvOptions): string {
  const formatDate =
    options?.formatDate ?? ((value: Date) => value.toISOString().slice(0, 10));

  const lines: string[] = [];

  if (options?.includeHeaderBlock !== false) {
    lines.push(escapeCsvField(dataset.title));
    if (dataset.subtitle) lines.push(escapeCsvField(dataset.subtitle));
    for (const entry of dataset.meta ?? []) {
      lines.push(
        [entry.label, entry.value].map((v) => escapeCsvField(String(v))).join(","),
      );
    }
    // Blank separator so the table starts on its own row block.
    if (lines.length > 0) lines.push("");
  }

  lines.push(dataset.columns.map((c) => escapeCsvField(c.header)).join(","));

  for (const row of dataset.rows) {
    lines.push(
      dataset.columns
        .map((column) => {
          const value = row[column.key];
          // Emit raw numbers so spreadsheets treat the column as numeric.
          if (typeof value === "number" && isNumericColumn(column)) {
            return Number.isFinite(value) ? String(value) : "";
          }
          return escapeCsvField(formatCell(value, column.type, formatDate));
        })
        .join(","),
    );
  }

  if (hasTotals(dataset) && dataset.rows.length > 0) {
    const totals = computeTotals(dataset);
    lines.push(
      dataset.columns
        .map((column, index) => {
          if (index === 0) return escapeCsvField("Total");
          const value = totals[column.key];
          return value === undefined ? "" : String(Math.round(value * 100) / 100);
        })
        .join(","),
    );
  }

  return lines.join("\r\n");
}

/**
 * CSV as bytes, with a UTF-8 BOM.
 *
 * Excel on Windows assumes the system codepage without it and mangles any
 * non-ASCII text - which matters here, since Phase 5 brings Nepali names.
 */
export function toCsvBuffer(dataset: ReportDataset, options?: CsvOptions): Buffer {
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(toCsv(dataset, options), "utf8"),
  ]);
}
