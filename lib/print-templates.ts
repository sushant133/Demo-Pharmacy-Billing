/**
 * Bill layouts, one per kind of printer a pharmacy actually owns.
 *
 * Counters in Nepal print on whatever the shop already had: a 58mm or 80mm
 * thermal roll at a busy till, an A4 or A5 sheet on an inkjet in a quieter
 * shop, and continuous tractor-feed paper on the dot-matrix machines that
 * refuse to die. The same invoice has to come out correctly on all of them,
 * so the layout is data rather than one hard-coded 80mm stylesheet.
 *
 * Superadmin assigns one of these to each pharmacy. Nothing here touches the
 * database or React, so the catalogue can be read from a server page, a
 * client preview and the PDF renderer alike.
 *
 * What a template does not decide is what the bill says. Every field VAT
 * Rules 2053 requires is printed by every template. A narrow roll moves the
 * batch and expiry onto a sub-line instead of giving them a column of their
 * own; it never drops them.
 */

export const PRINT_TEMPLATE_IDS = [
  "thermal-58",
  "thermal-80",
  "a5-portrait",
  "a4-portrait",
  "a4-duplicate",
  "letter-portrait",
  "dotmatrix-half",
  "dotmatrix-wide",
] as const;

export type PrintTemplateId = (typeof PRINT_TEMPLATE_IDS)[number];

/** What every pharmacy printed before templates existed. */
export const DEFAULT_PRINT_TEMPLATE: PrintTemplateId = "thermal-80";

/** Roll printers stack each line; sheet printers can afford real columns. */
export type BillLayout = "roll" | "table";

export type PrinterKind = "thermal" | "sheet" | "dotmatrix";

/** Columns a `table` layout prints, in order. A `roll` ignores this. */
export type BillColumn =
  | "index"
  | "item"
  | "batch"
  | "expiry"
  | "qty"
  | "rate"
  | "amount";

export interface PrintTemplate {
  id: PrintTemplateId;
  /** What the shop calls the paper. */
  label: string;
  /** What the shop calls the machine. */
  printer: string;
  kind: PrinterKind;
  /** One line for whoever is choosing, in plain words. */
  summary: string;
  /** Who this suits, for the superadmin gallery. */
  suitedTo: string;

  /** Physical paper width, mm. Drives the `@page` size. */
  paperWidthMm: number;
  /** Physical paper height, mm. `null` is a continuous roll or tractor feed. */
  paperHeightMm: number | null;
  /** Unprintable edge the printer needs, mm. */
  marginMm: number;
  /** Width the content is laid out in, mm. Never wider than paper less margins. */
  contentWidthMm: number;
  /** Body text size on paper, px. */
  fontPx: number;

  layout: BillLayout;
  columns: BillColumn[];

  /**
   * Characters per line for the direct ESC/POS path, or `null` when this
   * paper is not a thermal roll and the Bluetooth button should stay hidden.
   */
  escposColumns: number | null;

  /** Dot-matrix heads render one fixed-pitch face well and shading badly. */
  monospace: boolean;
  /** Only a sheet has room to leave a line for a signature. */
  showSignature: boolean;
  /**
   * One rendered document per entry, each carrying this caption. A
   * single-entry list is the ordinary case; two is the shop that files a copy.
   */
  copies: string[];
}

const ROLL_COLUMNS: BillColumn[] = ["index", "item", "amount"];

const FULL_COLUMNS: BillColumn[] = [
  "index",
  "item",
  "batch",
  "expiry",
  "qty",
  "rate",
  "amount",
];

/** A5 and half-width tractor paper: room for the batch, not also the expiry. */
const COMPACT_COLUMNS: BillColumn[] = ["index", "item", "batch", "qty", "rate", "amount"];

export const PRINT_TEMPLATES: Record<PrintTemplateId, PrintTemplate> = {
  "thermal-58": {
    id: "thermal-58",
    label: "58mm thermal roll",
    printer: "Thermal / POS roll printer",
    kind: "thermal",
    summary:
      "Narrow till roll. One column, no signature line, 32-character ESC/POS.",
    suitedTo: "Small counters and handheld Bluetooth printers.",
    paperWidthMm: 58,
    paperHeightMm: null,
    marginMm: 2,
    contentWidthMm: 54,
    fontPx: 9,
    layout: "roll",
    columns: ROLL_COLUMNS,
    escposColumns: 32,
    monospace: false,
    showSignature: false,
    copies: [""],
  },
  "thermal-80": {
    id: "thermal-80",
    label: "80mm thermal roll",
    printer: "Thermal / POS roll printer",
    kind: "thermal",
    summary:
      "The usual till roll. One column, 42-character ESC/POS, cuts to length.",
    suitedTo: "Most pharmacy counters. The platform default.",
    paperWidthMm: 80,
    paperHeightMm: null,
    marginMm: 2,
    contentWidthMm: 76,
    fontPx: 11,
    layout: "roll",
    columns: ROLL_COLUMNS,
    escposColumns: 42,
    monospace: false,
    showSignature: true,
    copies: [""],
  },
  "a5-portrait": {
    id: "a5-portrait",
    label: "A5 portrait",
    printer: "Inkjet or laser sheet printer",
    kind: "sheet",
    summary: "Half-sheet invoice with batch, quantity and rate in columns.",
    suitedTo: "Shops that hand over a filed invoice but not a full page.",
    paperWidthMm: 148,
    paperHeightMm: 210,
    marginMm: 10,
    contentWidthMm: 128,
    fontPx: 10,
    layout: "table",
    columns: COMPACT_COLUMNS,
    escposColumns: null,
    monospace: false,
    showSignature: true,
    copies: [""],
  },
  "a4-portrait": {
    id: "a4-portrait",
    label: "A4 portrait",
    printer: "Inkjet or laser sheet printer",
    kind: "sheet",
    summary: "Full-page tax invoice: batch, expiry, quantity, rate and amount.",
    suitedTo: "Wholesale counters and anyone billing institutions.",
    paperWidthMm: 210,
    paperHeightMm: 297,
    marginMm: 12,
    contentWidthMm: 186,
    fontPx: 11,
    layout: "table",
    columns: FULL_COLUMNS,
    escposColumns: null,
    monospace: false,
    showSignature: true,
    copies: [""],
  },
  "a4-duplicate": {
    id: "a4-duplicate",
    label: "A4 portrait, buyer and office copy",
    printer: "Inkjet or laser sheet printer",
    kind: "sheet",
    summary:
      "The A4 invoice twice, captioned, so one page goes out and one is filed.",
    suitedTo: "Shops that keep a paper file of every invoice issued.",
    paperWidthMm: 210,
    paperHeightMm: 297,
    marginMm: 12,
    contentWidthMm: 186,
    fontPx: 11,
    layout: "table",
    columns: FULL_COLUMNS,
    escposColumns: null,
    monospace: false,
    showSignature: true,
    copies: ["Original — buyer's copy", "Duplicate — office copy"],
  },
  "letter-portrait": {
    id: "letter-portrait",
    label: "US Letter portrait",
    printer: "Inkjet or laser sheet printer",
    kind: "sheet",
    summary: "The A4 layout on 8.5 by 11 inch stock.",
    suitedTo: "Printers stocked with imported Letter paper rather than A4.",
    paperWidthMm: 216,
    paperHeightMm: 279,
    marginMm: 12,
    contentWidthMm: 192,
    fontPx: 11,
    layout: "table",
    columns: FULL_COLUMNS,
    escposColumns: null,
    monospace: false,
    showSignature: true,
    copies: [""],
  },
  "dotmatrix-half": {
    id: "dotmatrix-half",
    label: "Dot matrix, 9.5 by 5.5 inch",
    printer: "Impact / tractor-feed printer",
    kind: "dotmatrix",
    summary: "Half-height continuous stationery, fixed-pitch, no shaded fills.",
    suitedTo: "Shops still running a narrow-carriage impact printer.",
    paperWidthMm: 241,
    paperHeightMm: 140,
    marginMm: 6,
    contentWidthMm: 229,
    fontPx: 10,
    layout: "table",
    columns: COMPACT_COLUMNS,
    escposColumns: null,
    monospace: true,
    showSignature: true,
    copies: [""],
  },
  "dotmatrix-wide": {
    id: "dotmatrix-wide",
    label: "Dot matrix, 15 by 11 inch wide carriage",
    printer: "Impact / tractor-feed printer",
    kind: "dotmatrix",
    summary: "Wide continuous stationery with every column, fixed-pitch.",
    suitedTo: "Distributors billing long orders on carbon-copy stationery.",
    paperWidthMm: 381,
    paperHeightMm: 279,
    marginMm: 8,
    contentWidthMm: 365,
    fontPx: 10,
    layout: "table",
    columns: FULL_COLUMNS,
    escposColumns: null,
    monospace: true,
    showSignature: true,
    copies: [""],
  },
};

/** Every template, in the order the gallery and the pickers show them. */
export const PRINT_TEMPLATE_LIST: PrintTemplate[] = PRINT_TEMPLATE_IDS.map(
  (id) => PRINT_TEMPLATES[id],
);

/**
 * The template for a stored id.
 *
 * Never throws. A pharmacy carrying the id of a template that was later
 * withdrawn still has to be able to print, and the 80mm roll is the layout
 * every one of them could already produce.
 */
export function printTemplate(id: string | null | undefined): PrintTemplate {
  const known = PRINT_TEMPLATE_IDS.find((candidate) => candidate === id);
  return PRINT_TEMPLATES[known ?? DEFAULT_PRINT_TEMPLATE];
}

export function isPrintTemplateId(value: unknown): value is PrintTemplateId {
  return typeof value === "string" && PRINT_TEMPLATE_IDS.some((id) => id === value);
}

/** 1mm in PostScript points, which is what pdfkit measures pages in. */
export const MM_TO_PT = 72 / 25.4;

export function mmToPt(mm: number): number {
  return Math.round(mm * MM_TO_PT * 100) / 100;
}

/**
 * The `@page` rule this paper needs, as text to drop into a `<style>`.
 *
 * `@page` cannot be selected by class, so the size cannot sit in the
 * stylesheet beside the rest of the receipt rules: the page being printed has
 * to declare its own. A continuous roll asks for `auto` height so the driver
 * cuts at the end of the bill instead of ejecting a fixed sheet.
 */
export function pageRule(template: PrintTemplate): string {
  const height =
    template.paperHeightMm === null ? "auto" : `${template.paperHeightMm}mm`;
  return `@page { size: ${template.paperWidthMm}mm ${height}; margin: ${template.marginMm}mm; }`;
}

/**
 * CSS custom properties the receipt stylesheet reads.
 *
 * A plain record, so it can be spread into a `style` prop on either side of
 * the server/client boundary.
 */
export function receiptVars(template: PrintTemplate): Record<string, string> {
  return {
    "--receipt-width": `${template.contentWidthMm}mm`,
    "--receipt-font": `${template.fontPx}px`,
    "--receipt-pad": template.layout === "roll" ? "4mm 3mm 6mm" : "6mm 5mm 8mm",
  };
}

/** Does this template print the given column? */
export function hasColumn(template: PrintTemplate, column: BillColumn): boolean {
  return template.columns.includes(column);
}
