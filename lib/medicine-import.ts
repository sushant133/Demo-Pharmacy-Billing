import { medicineSchema } from "@/lib/validation";

/**
 * Parsing a pasted or uploaded catalogue.
 *
 * Pure and free of database imports, so the column matching and the row
 * validation - the parts that decide what a shop's spreadsheet actually meant
 * - are testable without Mongo.
 *
 * Two rules shape the whole thing:
 *
 *   1. Nothing is written until the whole file has been read. A half-imported
 *      catalogue is worse than none: the user cannot tell which lines landed,
 *      and re-running it duplicates whatever did. So parsing produces a plan,
 *      the plan is shown, and only then does anything commit.
 *   2. A bad row never stops a good one. A 400-line spreadsheet will have
 *      three rows with a typo in the pack size, and refusing the lot over them
 *      means the shop gives up and types it all in by hand. Bad rows are
 *      reported with their line number and skipped.
 */

/** Columns we understand, and the spellings a real spreadsheet uses. */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  name: ["name", "medicine", "medicine name", "brand", "brand name", "product"],
  genericName: ["generic", "generic name", "molecule"],
  saltComposition: ["salt", "salt composition", "composition", "strength"],
  manufacturer: ["manufacturer", "maker", "company", "mfg", "brand owner"],
  category: ["category", "type", "group"],
  unit: ["unit", "form", "dosage form"],
  packSize: ["pack", "pack size", "packing"],
  sku: ["sku", "code", "item code", "product code"],
  barcode: ["barcode", "ean", "upc"],
  unitsPerStrip: ["units per strip", "per strip", "strip size", "tablets per strip"],
  defaultCostPrice: ["cost", "purchase price", "cost price", "buying price", "pp"],
  defaultSalePrice: ["mrp", "sale price", "selling price", "price", "sp"],
  reorderLevel: ["reorder", "reorder level", "min stock", "minimum stock"],
  requiresPrescription: ["rx", "prescription", "requires prescription", "prescription required"],
};

/** Header text to a known field, or null when the column is not one we use. */
export function matchColumn(header: string): string | null {
  const needle = header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!needle) return null;

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(needle)) return field;
  }
  return null;
}

/**
 * Split one CSV line, honouring quotes.
 *
 * Written out rather than `split(",")` because a salt composition routinely
 * contains a comma - "Amoxicillin 500mg, Clavulanic Acid 125mg" - and naive
 * splitting turns one medicine into two nonsense columns.
 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted cell is one literal quote.
        if (line[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Truthy spellings a spreadsheet uses for a yes/no column. */
function parseBoolean(value: string): boolean {
  return ["yes", "y", "true", "1", "rx", "required"].includes(
    value.trim().toLowerCase(),
  );
}

export interface ImportRow {
  /** 1-based line in the original file, so an error names what the user sees. */
  line: number;
  name: string;
  /** Parsed and valid, ready to create. Null when the row was refused. */
  value: Record<string, unknown> | null;
  error: string | null;
}

export interface ImportPlan {
  /** Fields recognised in the header, in file order. */
  columns: string[];
  /** Header cells we did not recognise, so the user knows what was dropped. */
  ignored: string[];
  rows: ImportRow[];
  validCount: number;
  errorCount: number;
}

/**
 * Turn pasted CSV into a plan: what would be created, and what is wrong.
 *
 * Nothing here touches the database, so duplicate names are *not* caught at
 * this stage - only the shape of each row is. The service checks the catalogue
 * afterwards, because only it can.
 */
export function parseMedicineCsv(text: string): ImportPlan {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { columns: [], ignored: [], rows: [], validCount: 0, errorCount: 0 };
  }

  const headerCells = splitCsvLine(lines[0]!);
  const mapped = headerCells.map(matchColumn);
  const columns = mapped.filter((field): field is string => field !== null);
  const ignored = headerCells.filter((_, index) => mapped[index] === null);

  const rows: ImportRow[] = [];

  for (let index = 1; index < lines.length; index++) {
    const cells = splitCsvLine(lines[index]!);
    const raw: Record<string, string> = {};

    mapped.forEach((field, column) => {
      if (field) raw[field] = cells[column] ?? "";
    });

    const line = index + 1;
    const name = raw.name ?? "";

    if (!name.trim()) {
      rows.push({
        line,
        name: "",
        value: null,
        error: "No medicine name in this row.",
      });
      continue;
    }

    const parsed = medicineSchema.safeParse({
      ...raw,
      requiresPrescription: parseBoolean(raw.requiresPrescription ?? ""),
      // Blank cells must reach the schema as "" so its own empty-to-null
      // transforms run, rather than as undefined which would skip them.
      unitsPerStrip: raw.unitsPerStrip ?? "",
      defaultCostPrice: raw.defaultCostPrice ?? "",
      defaultSalePrice: raw.defaultSalePrice ?? "",
      reorderLevel: raw.reorderLevel ?? "",
    });

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      rows.push({
        line,
        name,
        value: null,
        error: issue
          ? `${String(issue.path[0] ?? "row")}: ${issue.message}`
          : "This row could not be read.",
      });
      continue;
    }

    rows.push({ line, name, value: parsed.data, error: null });
  }

  return {
    columns,
    ignored,
    rows,
    validCount: rows.filter((row) => row.value !== null).length,
    errorCount: rows.filter((row) => row.value === null).length,
  };
}

/** The header a shop can download, fill in and paste back. */
export const IMPORT_TEMPLATE_HEADER =
  "Name,Generic,Manufacturer,Category,Unit,Pack size,SKU,Barcode,Units per strip,Purchase price,MRP,Reorder level,Rx";
