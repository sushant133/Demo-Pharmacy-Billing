import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchCatalogue,
  parseListText,
  readAmount,
  readHeader,
  readRowNumbers,
  splitRowText,
  type OcrLine,
} from "@/lib/medicine-ocr";
import { parseMedicineCsv, photoRowsToCsv } from "@/lib/medicine-import";

/**
 * Three real supplier bills, photographed on a phone and sent over WhatsApp:
 * a laser-printed credit memo with a ruled grid, a laser "estimate bill" with
 * pen ticks across the numbers, and a faint dot-matrix invoice. The fixtures
 * are what the OCR engine read from each photo (table rows and totals only -
 * no names, PAN or phone numbers), so these tests pin down how the parser
 * turns real, imperfect OCR into import rows.
 */
const fixture = (name: string): OcrLine[] =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ocr-bills", `${name}.json`), "utf8"));

/** Lines above every table: the parser must never take these for medicines. */
const letterhead: OcrLine[] = ["INVOICE", "Credit Memo", "ESTIMATE BILL", "Invoice Date : 06/25/2026"].map(
  (text) => ({ text, height: 40, confidence: 90 }),
);

const summary = (rows: ReturnType<typeof parseListText>["rows"]) =>
  rows.map((row) => [row.name, row.packSize, row.purchasePrice, row.mrp]);

describe("a laser-printed bill with a ruled grid", () => {
  const { rows, note } = parseListText([...letterhead, ...fixture("murarka")]);

  it("reads every item, and nothing but the items", () => {
    expect(summary(rows)).toEqual([
      ["ERICOB 90MG TAB", "10S", 120.7, 140],
      ["LACRYL G 10ML", "1 PHL", 189.69, 220],
      ["IDFLO EYE /EAR DROP 5ML", "1 PHL", 68.97, 80],
      ["CLOTRIBEST 10ML", "1 PHL", 68.97, 80],
    ]);
    expect(note).toBe("");
  });

  it("gives import rows the import parser accepts", () => {
    const plan = parseMedicineCsv(photoRowsToCsv(rows).csv);
    expect(plan.errorCount).toBe(0);
    expect(plan.rows[0]?.value).toMatchObject({
      name: "ERICOB 90MG TAB",
      unit: "tablet",
      defaultCostPrice: 120.7,
      defaultSalePrice: 140,
    });
  });
});

describe("a bill with pen ticks across the numbers", () => {
  const { rows, note } = parseListText(fixture("estimate"));

  it("finds all eleven items with their rates", () => {
    expect(rows.map((row) => [row.name, row.purchasePrice])).toEqual([
      ["B-COLEN SYR 200ML", 147.94],
      ["SOLVINCOLD AF SYRUP", 103.48],
      ["MUCO BM 100ML SYP", 89.8],
      ["FEBREX PLUS SYR 60ML", 84.7],
      ["NIKO TAB", 8.62],
      // "PERINORM INJ" - a tick through the serial number took the P.
      ["ERINORM IN", 8.25],
      ["BETNOR E/E DROPS 5ML", 79.46],
      ["FLEXON TABS", 24.65],
      ["DEZACOR SYRUP", 112.18],
      ["ORNADO TAB", 86.21],
      // "VISCO LIQUID" - under a tick; the catalogue match is what fixes this.
      ["SCO UQUIB", 119.31],
    ]);
  });

  it("reads the MRPs, leaving out the one a tick made unreadable", () => {
    const mrp = Object.fromEntries(rows.map((row) => [row.name, row.mrp]));
    expect(mrp).toMatchObject({
      "B-COLEN SYR 200ML": 108.5,
      "SOLVINCOLD AF SYRUP": 75,
      "MUCO BM 100ML SYP": 104,
      "FEBREX PLUS SYR 60ML": 61.8,
      "NIKO TAB": 10,
      "BETNOR E/E DROPS 5ML": 57.48,
      "FLEXON TABS": 18.37,
      "DEZACOR SYRUP": 87.23,
      "SCO UQUIB": 92.76,
      // Printed 5.98, read "59": far from the rate, so dropped rather than imported.
      "ERINORM IN": null,
    });
    expect(note).toContain("1 row's MRP could not be read");
  });

  it("splits pack from name, including a pack glued to its batch", () => {
    expect(rows.map((row) => row.packSize)).toEqual([
      "1PH",
      "60ML",
      "100ML",
      "1PH",
      "10X1",
      "",
      "1PCS",
      "15'S",
      "30ML",
      "10'S",
      "200M",
    ]);
  });
});

describe("a faint dot-matrix bill", () => {
  const { rows, note } = parseListText(fixture("baba"));

  it("finds every item row", () => {
    expect(rows).toHaveLength(5);
    expect(rows[4]?.name).toBe("G-MAX-C LOTION");
  });

  it("never invents a price: unreadable prices stay blank and are flagged", () => {
    // The only rate recovered is the one the arithmetic proves: 5500.00 / 275.00 = 20.
    expect(rows.map((row) => row.purchasePrice)).toEqual([null, null, 275, null, null]);
    expect(note).toContain("4 rows' prices could not be read with certainty");
    expect(note).toContain("quantity was unclear");
  });
});

describe("learning from the shop's catalogue", () => {
  const catalogue = [
    { name: "G-MAX SOAP75GM", unit: "soap", packSize: "1PC" },
    { name: "FOOTCURE CREAM 75GM", unit: "cream" },
    { name: "KETOCURE POWDER 100GM", unit: "powder" },
    { name: "PERINORM INJ", unit: "injection", manufacturer: "Ipca" },
    { name: "VISCO LIQUID" },
    { name: "CETZINE 10MG" },
  ];

  it("corrects smudged names to the medicines the shop already has", () => {
    expect(matchCatalogue("G-NAX SOAPTSGH", catalogue)?.name).toBe("G-MAX SOAP75GM");
    expect(matchCatalogue("FOITCURE CREA 756M", catalogue)?.name).toBe("FOOTCURE CREAM 75GM");
    expect(matchCatalogue("KETOCURE PONDER 100GU", catalogue)?.name).toBe("KETOCURE POWDER 100GM");
    expect(matchCatalogue("ERINORM IN", catalogue)?.name).toBe("PERINORM INJ");
  });

  it("leaves a name alone when nothing is close enough", () => {
    expect(matchCatalogue("SCO UQUIB", catalogue)).toBeNull();
    expect(matchCatalogue("BRAND NEW SYRUP", catalogue)).toBeNull();
  });

  it("fills a matched row's blanks from the catalogue and says so", () => {
    const { rows, note } = parseListText(fixture("baba"), catalogue);
    expect(rows.slice(0, 3).map((row) => [row.name, row.unit])).toEqual([
      ["G-MAX SOAP75GM", "soap"],
      ["FOOTCURE CREAM 75GM", "cream"],
      ["KETOCURE POWDER 100GM", "powder"],
    ]);
    expect(note).toContain("matched to medicines you already have");
  });
});

describe("bill rules", () => {
  it("places the decimal point from the digits when a bill prints every amount as 0.00", () => {
    expect(readAmount("12070", true)).toBe(120.7);
    expect(readAmount("1.20700", true)).toBe(1207);
    expect(readAmount("1,043.30", true)).toBe(1043.3);
    expect(readAmount("10,00", true)).toBe(10);
    expect(readAmount("500", true)).toBe(5);
    expect(readAmount("J000", true)).toBe(10);
  });

  it("refuses words that are not numbers", () => {
    expect(readAmount("HELI", true)).toBeNull();
    expect(readAmount("Ta.)", true)).toBeNull();
    expect(readAmount("~", true)).toBeNull();
  });

  it("reads the column order from a header, tolerating OCR slips", () => {
    expect(readHeader("S.N. Description Pack Batch Expiry Qty Free Rate Amount MRP")).toEqual([
      "qty",
      "free",
      "rate",
      "amount",
      "mrp",
    ]);
    expect(readHeader("SNO. DESCRIPTION PACKING BATCH NO EXPIRY QUANTITY FREE RATE AMOUNT WAP. REMARKS")).toEqual([
      "qty",
      "free",
      "rate",
      "amount",
    ]);
    expect(readHeader("In Words: Rupees Three Thousand")).toBeNull();
  });

  it("anchors a row on qty x rate = amount, preferring rate and amount side by side", () => {
    // qty, free, rate, amount, MRP, discount: 5 x 1.00 = 5.00 must not win over 5 x 68.97.
    expect(readRowNumbers(["5.00", "1.00", "68.97", "344.85", "80.00", "5.00"], null, true)).toMatchObject({
      qty: 5,
      rate: 68.97,
      amount: 344.85,
      mrp: 80,
    });
  });

  it("does not accept a near miss", () => {
    // 5 x 378.30 = 1891.50, not 1898.50: both were misread, so no price at all.
    expect(readRowNumbers(["5.00", "378.30", "1898.50", "75.00"], null, true)).toBeNull();
  });

  it("splits name, pack and batch", () => {
    expect(splitRowText(["eX", "5", "LACRYL", "G", "10ML", "1", "PHL", "ECSGD004"])).toEqual({
      name: "LACRYL G 10ML",
      pack: "1 PHL",
      batch: "ECSGD004",
    });
    expect(splitRowText(["«_", "9", "DEZACOR", "SYRUP", "30MLMPJ253614"])).toEqual({
      name: "DEZACOR SYRUP",
      pack: "30ML",
      batch: "MPJ253614",
    });
    expect(splitRowText(["_10_ORNADO", "TAB", "10'S", "483"])).toEqual({ name: "ORNADO TAB", pack: "10'S", batch: "483" });
  });
});
