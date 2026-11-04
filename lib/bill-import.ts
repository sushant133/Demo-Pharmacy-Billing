import { detectDelimiter, jsonToCsv, splitCsvLine } from "@/lib/medicine-import";
import { canSellLoose, parsePackSize, piecesPerStrip } from "@/lib/pack";

/**
 * A supplier's bill brought into a purchase: from a photo (read by OCR) or
 * from the supplier's Excel / CSV export. Both end up as the same lines, shown
 * in the same editable preview, and only then turned into purchase lines.
 *
 * Pure and free of database and OCR imports, so it runs in the browser (the
 * preview converts as the user edits) and in tests.
 */

const TEXT_FILE = /\.(csv|tsv|txt|json)$/i;

const WORKBOOK_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

/**
 * How to read an uploaded bill file. The file name is asked before the type: with
 * Excel installed, Windows browsers report a .csv as application/vnd.ms-excel,
 * which would otherwise send plain text to the workbook reader.
 */
export function billFileKind(type: string, name: string): "workbook" | "text" | null {
  if (TEXT_FILE.test(name)) return "text";
  if (WORKBOOK_TYPES.includes(type) || /\.xlsx$/i.test(name)) return "workbook";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return null;
}

/** One item line of a bill, in the bill's own terms: packs, per-pack prices. */
export interface BillLine {
  description: string;
  /** As printed: "10 S", "1 PHL", "60ML", "10X1". */
  pack: string;
  batch: string;
  /** "MM/YYYY", or blank when the bill's expiry could not be read. */
  expiry: string;
  quantity: number | null;
  free: number | null;
  /** Purchase rate per pack. */
  rate: number | null;
  amount: number | null;
  mrp: number | null;
  /** quantity x rate = amount holds, so the numbers were read right. */
  checked: boolean;
}

export interface BillReading {
  lines: BillLine[];
  invoiceNo: string;
  /** AD YYYY-MM-DD, or blank. */
  invoiceDate: string;
  /** The top of the bill - the supplier's name is usually here. */
  letterhead: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * An expiry as bills and spreadsheets write it, as "MM/YYYY": "04/2027",
 * "4/27", "05-2028", "Apr-27", "Apr 2027", or a full date "2027-04-30" /
 * "30/04/2027". Blank when it is not a real month.
 */
export function tidyExpiry(text: string): string {
  const trimmed = text.trim().replace(/[.,]$/, "");
  // Read before digits are repaired: that repair turns "Oct" into "0ct" and "Jul"
  // into "Ju1", so any month with an O, I or L in its name would never match.
  const named = trimmed.toLowerCase().match(/^([a-z]{3})[a-z]*[\s\-/']*([\doil]{2,4})$/);
  const raw = trimmed.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
  let month: number | null = null;
  let year: number | null = null;

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
  const full = raw.match(/^\d{1,2}[-/](\d{1,2})[-/](\d{4})$/);
  const short = raw.match(/^(\d{1,2})[-/](\d{2}|\d{4})$/);
  if (named && MONTHS.includes(named[1]!)) {
    month = MONTHS.indexOf(named[1]!) + 1;
    year = Number(named[2]!.replace(/o/g, "0").replace(/[il]/g, "1"));
    if (named[2]!.length === 3) year = null;
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
  } else if (full) {
    month = Number(full[1]);
    year = Number(full[2]);
  } else if (short) {
    month = Number(short[1]);
    year = Number(short[2]);
  }
  if (month == null || year == null) return "";
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return "";
  return `${String(month).padStart(2, "0")}/${year}`;
}

/** "04/2027" → "2027-04-30": a lot is good to the end of its expiry month. */
export function expiryToDate(expiry: string): string {
  const match = expiry.match(/^(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const month = Number(match[1]);
  const year = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${match[1]}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * An invoice date as printed, to AD YYYY-MM-DD. Nepali bills print
 * DD/MM/YYYY; a day above 12 in the second place means the bill used
 * MM/DD/YYYY instead. Bikram Sambat dates (year 2070-2099) are left alone -
 * the "Miti" line is not the AD date.
 */
export function tidyInvoiceDate(text: string): string {
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  let day: number;
  let month: number;
  let year: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const match = text.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
    if (!match) return "";
    const first = Number(match[1]);
    const second = Number(match[2]);
    year = Number(match[3]);
    [day, month] = second > 12 ? [second, first] : [first, second];
  }
  if (year < 2000 || year > 2069 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Packs to pieces
// ---------------------------------------------------------------------------

/**
 * Pieces in one pack as a bill prints it, for a line billed per pack: "10 S",
 * "15'S" and "10S" are strips of that many; "10x10" and "1x15" follow the
 * rest of the app (lib/pack); a bottle, tube, phial or vial is one piece.
 * Forms that are not sold loose are always one per pack.
 */
export function unitsPerPack(pack: string, unit: string): number {
  if (!canSellLoose(unit)) return 1;
  const text = pack.trim().toLowerCase().replace(/\s+/g, "");
  const strip = text.match(/^(\d{1,3})['`’"]?s$/);
  if (strip) return Math.max(1, Number(strip[1]));
  const parsed = parsePackSize(text);
  return parsed ? piecesPerStrip(parsed.strips, parsed.pieces) : 1;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

export interface PurchaseQuantities {
  /** Pieces billed. */
  quantity: number;
  /** Pieces received free. */
  freeQuantity: number;
  /** Per piece. */
  costPrice: number;
  /** Per piece. */
  salePrice: number;
  /** How the bill's figures were turned into these, when it was not plain. */
  explanation: string;
}

/**
 * A bill line (packs, per-pack prices) as a purchase line (pieces, per-piece
 * prices), the way stock is counted everywhere else in the app.
 *
 * Bills often bill a fraction of a pack - "5.50 + 0.50 free" is six bottles
 * with the scheme spread over the price. When the billed and free quantities
 * are not whole pieces but their sum is, the whole delivery is taken as
 * billed at the line's amount: same money, same stock, whole numbers.
 */
export function toPurchaseQuantities(
  line: Pick<BillLine, "quantity" | "free" | "rate" | "amount" | "mrp">,
  perPack: number,
): PurchaseQuantities | { error: string } {
  const packs = line.quantity ?? 0;
  const freePacks = line.free ?? 0;
  if (packs <= 0 && freePacks <= 0) return { error: "Enter the quantity." };
  if (line.rate == null && line.amount == null) return { error: "Enter the rate." };
  if (line.mrp == null) return { error: "Enter the MRP." };

  const pieces = packs * perPack;
  const freePieces = freePacks * perPack;
  const whole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6;
  const rate = line.rate ?? (line.amount ?? 0) / (packs || 1);
  const salePrice = round4(line.mrp / perPack);

  if (whole(pieces) && whole(freePieces)) {
    return {
      quantity: Math.round(pieces),
      freeQuantity: Math.round(freePieces),
      costPrice: round4(rate / perPack),
      salePrice,
      explanation: "",
    };
  }
  const total = pieces + freePieces;
  if (whole(total) && total > 0) {
    const amount = line.amount ?? rate * packs;
    return {
      quantity: Math.round(total),
      freeQuantity: 0,
      costPrice: round4(amount / total),
      salePrice,
      explanation: `${packs} + ${freePacks} free = ${Math.round(total)} received for the billed amount.`,
    };
  }
  return {
    error: `${packs}${freePacks ? ` + ${freePacks} free` : ""} is not a whole number of pieces - correct the quantity or the pieces per pack.`,
  };
}

/** qty x rate = amount, to the paisa (a little rounding allowed). */
export function lineAddsUp(line: Pick<BillLine, "quantity" | "rate" | "amount">): boolean {
  if (line.quantity == null || line.rate == null || line.amount == null) return false;
  // Rounding only: the printed rate is itself rounded to the paisa.
  return Math.abs(line.quantity * line.rate - line.amount) <= 0.011 + Math.abs(line.quantity) * 0.005;
}

// ---------------------------------------------------------------------------
// A spreadsheet
// ---------------------------------------------------------------------------

type BillField = "description" | "pack" | "batch" | "expiry" | "quantity" | "free" | "rate" | "amount" | "mrp";

const BILL_COLUMNS: Record<BillField, readonly string[]> = {
  description: [
    "description",
    "item description",
    "particulars",
    "particular",
    "item",
    "item name",
    "items",
    "product",
    "product name",
    "medicine",
    "medicine name",
    "name",
    "brand",
  ],
  pack: ["pack", "packing", "pack size", "pkg"],
  batch: ["batch", "batch no", "batch number", "batch no.", "lot", "lot no", "b.no", "bno"],
  expiry: ["expiry", "exp", "exp date", "expiry date", "exp.", "expiry dt", "exp dt"],
  quantity: ["qty", "quantity", "qnty", "billed qty", "qty."],
  free: ["free", "free qty", "bonus", "sch", "scheme", "free goods"],
  rate: ["rate", "purchase rate", "p rate", "p.rate", "prate", "cost", "cost price", "price", "unit price"],
  amount: ["amount", "amt", "value", "total", "net amount", "line total"],
  mrp: ["mrp", "m.r.p", "m.r.p.", "mrp.", "sale price", "selling price"],
};

function billField(header: string): BillField | null {
  const needle = header
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [field, aliases] of Object.entries(BILL_COLUMNS) as [BillField, readonly string[]][]) {
    if (aliases.includes(needle)) return field;
  }
  return null;
}

/** A spreadsheet number: "1,207.00", "Rs 140", "" → null. */
function sheetNumber(value: string | undefined): number | null {
  const cleaned = (value ?? "").replace(/(?:npr|rs)\.?/gi, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

/**
 * A supplier's Excel or CSV export as bill lines. The header row is found
 * among the opening rows (exports open with the supplier's name and address)
 * by its column names; every row after it with a description is a line,
 * until a totals row.
 */
export function sheetToBill(text: string): BillReading {
  const trimmed = text.trim();
  const csv = trimmed.startsWith("[") || trimmed.startsWith("{") ? jsonToCsv(trimmed) : text;
  const rows = csv
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => splitCsvLine(line, detectDelimiter(line)));

  let headerIndex = -1;
  let fields: (BillField | null)[] = [];
  for (let index = 0; index < Math.min(rows.length, 25); index++) {
    const mapped = rows[index]!.map(billField);
    const known = new Set(mapped.filter(Boolean));
    if (known.has("description") && known.size >= 3) {
      headerIndex = index;
      // A field named twice keeps its first column.
      fields = mapped.map((field, column) => (field && mapped.indexOf(field) !== column ? null : field));
      break;
    }
  }
  if (headerIndex < 0) {
    return {
      lines: [],
      invoiceNo: "",
      invoiceDate: "",
      letterhead: [],
      note: "No item columns found. The sheet needs a heading row with Description (or Item), and Qty, Rate, Batch, Expiry or MRP.",
    };
  }

  const at = (cells: string[], field: BillField) => {
    const column = fields.indexOf(field);
    return column >= 0 ? (cells[column] ?? "").trim() : "";
  };
  const lines: BillLine[] = [];
  for (const cells of rows.slice(headerIndex + 1)) {
    const description = at(cells, "description");
    if (!description) continue;
    if (/^((basic|sub|grand|net)\s?)?total\b|^(net|vat|discount|round\s?off|in words)\b/i.test(description)) break;
    const line: BillLine = {
      description,
      pack: at(cells, "pack"),
      batch: at(cells, "batch"),
      expiry: tidyExpiry(at(cells, "expiry")),
      quantity: sheetNumber(at(cells, "quantity")),
      free: sheetNumber(at(cells, "free")),
      rate: sheetNumber(at(cells, "rate")),
      amount: sheetNumber(at(cells, "amount")),
      mrp: sheetNumber(at(cells, "mrp")),
      checked: false,
    };
    // A sheet's numbers are typed, not read: they are right unless they
    // contradict each other.
    line.checked = line.amount == null || lineAddsUp(line);
    lines.push(line);
  }

  // Invoice number and date from the rows above the table.
  const above = rows.slice(0, headerIndex).map((cells) => cells.filter(Boolean).join(" "));
  const meta = invoiceMeta(above);
  return {
    lines,
    ...meta,
    letterhead: above.slice(0, 4),
    note: lines.length === 0 ? "The sheet has a heading row but no item lines under it." : "",
  };
}

/** Invoice number and date from the lines above a bill's table. */
export function invoiceMeta(lines: readonly string[]): { invoiceNo: string; invoiceDate: string } {
  let invoiceNo = "";
  let invoiceDate = "";
  for (const line of lines) {
    if (!invoiceNo) {
      const number = line.match(
        // A space inside the number only before more digits: "CR/ 629", never "06184 Date".
        /\b(?:invoice|inv|bill|credit\s*memo)\s*(?:no|n|number|#)?\.?\s*[:.©]?\s*([A-Z0-9][A-Z0-9/.-]*(?:\s\d[A-Z0-9/.-]*)?)/i,
      );
      if (number && /\d/.test(number[1]!)) invoiceNo = number[1]!.replace(/\s+/g, "");
    }
    if (!invoiceDate && /\bdate\b/i.test(line) && !/print|entry|miti/i.test(line)) {
      invoiceDate = tidyInvoiceDate(line.slice(line.search(/\bdate\b/i)));
    }
  }
  return { invoiceNo, invoiceDate };
}
