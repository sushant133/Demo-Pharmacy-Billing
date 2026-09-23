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
  name: [
    "name",
    "medicine",
    "medicine name",
    "brand",
    "brand name",
    "product",
    "product name",
    "item",
    "item name",
    "drug",
    "drug name",
  ],
  genericName: ["generic", "generic name", "molecule"],
  saltComposition: ["salt", "salt composition", "composition", "strength"],
  manufacturer: ["manufacturer", "maker", "company", "mfg", "brand owner"],
  category: ["category", "type", "group"],
  unit: ["unit", "form", "dosage form"],
  packSize: ["pack", "pack size", "packing"],
  sku: ["sku", "code", "item code", "product code"],
  barcode: ["barcode", "ean", "upc"],
  unitsPerStrip: ["units per strip", "per strip", "strip size", "tablets per strip"],
  defaultCostPrice: ["cost", "purchase price", "cost price", "buying price", "pp", "purchase rate", "cost rate"],
  defaultSalePrice: ["mrp", "sale price", "selling price", "price", "sp", "rate", "sale rate", "selling rate"],
  reorderLevel: ["reorder", "reorder level", "min stock", "minimum stock"],
  requiresPrescription: ["rx", "prescription", "requires prescription", "prescription required"],
};

/** Header text to a known field, or null when the column is not one we use. */
export function matchColumn(header: string): string | null {
  const needle = header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!needle) return null;

  const found = lookup(needle);
  if (found) return found;

  /*
    Second chance for decorated headings - "MRP (Rs.)", "Pack Size:",
    "genericName" from a JSON export. Only after an exact miss, so a plain
    heading never takes this looser path.
  */
  const loose = header
    .replace(/\([^)]*\)/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return loose && loose !== needle ? lookup(loose) : null;
}

function lookup(needle: string): string | null {
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
export function splitCsvLine(line: string, delimiter = ","): string[] {
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
    else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

/**
 * Which character separates the cells.
 *
 * Rows pasted straight out of Excel arrive tab-separated, and a European
 * locale's "CSV" uses semicolons - so the header line decides, counting only
 * separators outside quotes.
 */
export function detectDelimiter(line: string): string {
  const counts: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char]!++;
  }
  if (counts["\t"]! > 0 && counts["\t"]! >= counts[","]!) return "\t";
  if (counts[";"]! > counts[","]!) return ";";
  return ",";
}

/** Quote a cell only when it needs it, so the result stays readable. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = (
    typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)
  )
    .replace(/\r?\n/g, " ")
    .trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A grid of cells to CSV text, the one shape the importer reads. */
export function rowsToCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/**
 * JSON to CSV, so a JSON export goes through exactly the same checks.
 *
 * Accepts an array of objects, or an object holding one (`{ medicines: [...] }`,
 * `{ data: [...] }`) - the two shapes other systems actually export. Keys
 * become the headings, in the order they first appear.
 */
export function jsonToCsv(text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That JSON could not be read. Check it is valid JSON.");
  }

  if (!Array.isArray(data) && data && typeof data === "object") {
    const list = Object.values(data as Record<string, unknown>).find(Array.isArray);
    data = list ?? [data];
  }
  if (!Array.isArray(data)) {
    throw new Error("The JSON should be a list of medicines.");
  }

  const records = data.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
  if (records.length === 0) {
    throw new Error("The JSON list has no medicine records in it.");
  }

  const headers: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }

  // Nested objects have no column to land in; they are left blank.
  const cell = (value: unknown) =>
    value !== null && typeof value === "object" ? "" : value;

  return rowsToCsv([
    headers,
    ...records.map((record) => headers.map((key) => cell(record[key]))),
  ]);
}

/** Short and plural spellings of a dosage form, as spreadsheets write them. */
const UNIT_ALIASES: Record<string, string> = {
  tab: "tablet",
  tabs: "tablet",
  cap: "capsule",
  caps: "capsule",
  syp: "syrup",
  inj: "injection",
  oint: "ointment",
  drop: "drops",
  supp: "suppository",
};

/** Blank is left for the schema's default; anything unknown is passed on to be refused. */
function normaliseUnit(value: string | undefined): string | undefined {
  const unit = value?.trim().toLowerCase().replace(/\.$/, "");
  if (!unit) return undefined;
  if (UNIT_ALIASES[unit]) return UNIT_ALIASES[unit];
  if (unit.endsWith("s") && unit !== "drops") return unit.slice(0, -1);
  return unit;
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
  /** Every header cell and the field it was matched to, in file order. */
  mapping: Array<{ header: string; field: string | null }>;
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
  // Pasted or uploaded JSON is read as the CSV it describes.
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    text = jsonToCsv(trimmed);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { columns: [], mapping: [], ignored: [], rows: [], validCount: 0, errorCount: 0 };
  }

  /*
    The heading row is usually the first, but an exported report often opens
    with a title or the shop's name. So the first of the opening lines that
    names a medicine column is the header; failing that, line one.
  */
  let headerIndex = 0;
  for (let index = 0; index < Math.min(lines.length, 10); index++) {
    const cells = splitCsvLine(lines[index]!, detectDelimiter(lines[index]!));
    if (cells.some((cell) => matchColumn(cell) === "name")) {
      headerIndex = index;
      break;
    }
  }
  const delimiter = detectDelimiter(lines[headerIndex]!);

  const headerCells = splitCsvLine(lines[headerIndex]!, delimiter);
  const mapped = headerCells.map(matchColumn);
  // A field claimed by two columns keeps the first; the second is ignored.
  mapped.forEach((field, index) => {
    if (field && mapped.indexOf(field) !== index) mapped[index] = null;
  });
  const columns = mapped.filter((field): field is string => field !== null);
  const ignored = headerCells.filter(
    (header, index) => mapped[index] === null && header.length > 0,
  );
  const mapping = headerCells.map((header, index) => ({
    header,
    field: mapped[index] ?? null,
  }));

  const rows: ImportRow[] = [];

  for (let index = headerIndex + 1; index < lines.length; index++) {
    const cells = splitCsvLine(lines[index]!, delimiter);
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
      // A blank category or form takes the add form's default instead of
      // failing, and "Tablets" / "TAB" read as the form they mean.
      category: raw.category?.trim() || undefined,
      unit: normaliseUnit(raw.unit),
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
    mapping,
    ignored,
    rows,
    validCount: rows.filter((row) => row.value !== null).length,
    errorCount: rows.filter((row) => row.value === null).length,
  };
}

/** The header a shop can download, fill in and paste back. */
export const IMPORT_TEMPLATE_HEADER =
  "Name,Generic,Manufacturer,Category,Unit,Pack size,SKU,Barcode,Units per strip,Purchase price,MRP,Reorder level,Rx";
