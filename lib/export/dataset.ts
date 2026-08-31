/**
 * A format-neutral report dataset.
 *
 * CSV, Excel and PDF all render this same shape, so adding a report means
 * writing one query - not three exporters. Everything here is pure and
 * testable; the format-specific code deals only with bytes.
 */

export type ColumnType = "text" | "integer" | "money" | "number" | "date" | "percent";

export interface ReportColumn {
  key: string;
  header: string;
  type: ColumnType;
  /** Character width hint, used by Excel and to size PDF columns. */
  width?: number;
  /** Sum this column and show the total on a footer row. */
  total?: boolean;
}

export type CellValue = string | number | Date | null | undefined;
export type ReportRow = Record<string, CellValue>;

export interface ReportDataset {
  /** Used as the sheet name, PDF heading and download filename stem. */
  title: string;
  /** e.g. "1 Jan 2026 - 31 Mar 2026". Rendered under the title. */
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Key/value pairs printed above the table (filters, totals, context). */
  meta?: Array<{ label: string; value: string }>;
  /** Shown at the foot of a PDF; ignored by CSV. */
  note?: string;
  generatedAt?: Date;
}

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set([
  "integer",
  "money",
  "number",
  "percent",
]);

export function isNumericColumn(column: ReportColumn): boolean {
  return NUMERIC_TYPES.has(column.type);
}

/** Column totals for every column flagged `total`. */
export function computeTotals(dataset: ReportDataset): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const column of dataset.columns) {
    if (!column.total || !isNumericColumn(column)) continue;
    totals[column.key] = dataset.rows.reduce((sum, row) => {
      const value = row[column.key];
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
  }

  return totals;
}

export function hasTotals(dataset: ReportDataset): boolean {
  return dataset.columns.some((column) => column.total && isNumericColumn(column));
}

/**
 * Round away binary float drift before formatting.
 *
 * Plain `toFixed(2)` renders 1.005 as "1.00", because the double nearest
 * 1.005 is fractionally below it. The rest of the system rounds with this
 * epsilon correction, so exports must too - otherwise a figure disagrees
 * between the screen and the spreadsheet, which is precisely the kind of
 * discrepancy that destroys trust in a report.
 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Render one cell as display text.
 *
 * Dates are formatted in the business timezone by the caller-supplied
 * formatter so exports agree with what is on screen.
 */
export function formatCell(
  value: CellValue,
  type: ColumnType,
  formatDate: (value: Date) => string,
): string {
  if (value === null || value === undefined || value === "") return "";

  if (value instanceof Date) return formatDate(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    switch (type) {
      case "integer":
        return String(Math.round(value));
      case "money":
      case "number":
        return roundTo(value, 2).toFixed(2);
      case "percent":
        return `${roundTo(value, 1).toFixed(1)}%`;
      default:
        return String(value);
    }
  }

  return String(value);
}

/** A filesystem- and header-safe filename stem. */
export function filenameFor(dataset: ReportDataset, extension: string): string {
  const stem = dataset.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const stamp = (dataset.generatedAt ?? new Date()).toISOString().slice(0, 10);
  return `${stem || "report"}-${stamp}.${extension}`;
}

/**
 * Content-Disposition value.
 *
 * The filename is quoted and any quote or control character stripped, so a
 * report title can never break out of the header - a real injection vector
 * when titles contain user-supplied text like a supplier name.
 */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
