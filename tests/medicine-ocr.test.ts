import { describe, expect, it } from "vitest";
import { packReadingToFill } from "@/lib/medicine-image-import";
import { photoRowsToCsv, parseMedicineCsv } from "@/lib/medicine-import";
import {
  findBarcode,
  matchGeneric,
  parseListLine,
  parseListText,
  parsePackText,
  pricesFrom,
  repairDigits,
  validRetailCode,
  type OcrLine,
} from "@/lib/medicine-ocr";

/** Lines as Tesseract gives them: [text, pixel height, confidence]. */
const lines = (...rows: [string, number, number?][]): OcrLine[] =>
  rows.map(([text, height, confidence = 90]) => ({ text, height, confidence }));

describe("repairDigits", () => {
  it("fixes letters read inside numbers", () => {
    expect(repairDigits("Paracetamol 5OOmg")).toBe("Paracetamol 500mg");
    expect(repairDigits("MRP Rs. 1O.5O")).toBe("MRP Rs. 10.50");
    expect(repairDigits("l0 tablets")).toBe("10 tablets");
  });

  it("leaves words and vitamin names alone", () => {
    expect(repairDigits("Vitamin B12 Omez Oil")).toBe("Vitamin B12 Omez Oil");
  });
});

describe("matchGeneric", () => {
  it("finds known generics, allowing for OCR slips", () => {
    expect(matchGeneric("Paracetamol")).toEqual({ generic: "paracetamol", category: "Analgesic" });
    expect(matchGeneric("Paracetarnol")?.generic).toBe("paracetamol");
    expect(matchGeneric("Pantoprazo1e")?.generic).toBe("pantoprazole");
  });

  it("does not match ordinary words", () => {
    expect(matchGeneric("tablet")).toBeNull();
    expect(matchGeneric("store")).toBeNull();
    expect(matchGeneric("zinx")).toBeNull();
  });
});

describe("barcodes", () => {
  it("accepts only codes with a valid check digit", () => {
    expect(validRetailCode("8901030865275")).toBe(true);
    expect(validRetailCode("8901030865278")).toBe(false);
    expect(validRetailCode("96385074")).toBe(true);
  });

  it("finds a code printed in groups", () => {
    expect(findBarcode(["Batch 2345", "8 901030 865275"])).toBe("8901030865275");
    expect(findBarcode(["Mfg 01/2025 Exp 12/2027"])).toBe("");
  });
});

describe("parsePackText", () => {
  const pantop = lines(
    ["Rx", 30],
    ["PANTOP 40", 120],
    ["Pantoprazole Gastro-resistant Tablets IP", 40],
    ["Each enteric coated tablet contains:", 22],
    ["Pantoprazole Sodium IP eq. to Pantoprazole 40 mg", 22],
    ["10 x 10 Tablets", 30],
    ["M.R.P. Rs. 150.00 per strip of 10", 26],
    ["Incl. of all taxes", 20],
    ["Manufactured by: Aristo Pharmaceuticals Pvt. Ltd., Mumbai", 20],
    ["8 901030 865275", 24],
  );

  it("reads every field of a clear pack", () => {
    const reading = parsePackText(pantop);
    expect(reading).toMatchObject({
      isMedicinePack: true,
      name: "PANTOP 40",
      genericName: "Pantoprazole",
      saltComposition: "Pantoprazole 40mg",
      manufacturer: "Aristo Pharmaceuticals Pvt. Ltd.",
      category: "Antacid",
      unit: "tablet",
      packSize: "10x10",
      unitsPerStrip: 10,
      barcode: "8901030865275",
      mrp: 150,
      mrpForPieces: 10,
    });
  });

  it("turns the strip MRP into a per-tablet price for the form", () => {
    const fill = packReadingToFill(parsePackText(pantop));
    expect(fill.defaultSalePrice).toBe(15);
    expect(fill.mrpNote).toContain("Rs. 15.00 each");
  });

  it("joins a strength printed under the brand, and reads combinations", () => {
    const reading = parsePackText(
      lines(
        ["Moxikind-CV", 110],
        ["625", 70],
        ["Amoxycillin & Potassium Clavulanate Tablets IP", 30],
        ["Each film coated tablet contains:", 20],
        ["Amoxycillin Trihydrate IP eq. to Amoxycillin 500 mg", 20],
        ["Potassium Clavulanate Diluted IP eq. to Clavulanic Acid 125 mg", 20],
        ["Marketed by Mankind Pharma Ltd.", 20],
        ["1 x 6 Tablets", 24],
      ),
    );
    expect(reading.name).toBe("Moxikind-CV 625");
    expect(reading.saltComposition).toBe("Amoxycillin 500mg + Clavulanic Acid 125mg");
    expect(reading.genericName).toBe("Amoxycillin + Clavulanic");
    expect(reading.category).toBe("Antibiotic");
    expect(reading.manufacturer).toBe("Mankind Pharma Ltd.");
    expect(reading.packSize).toBe("1x6");
  });

  it("reads a syrup as one bottle", () => {
    const reading = parsePackText(
      lines(
        ["Cofset", 100],
        ["Ambroxol Hydrochloride Syrup", 30],
        ["Each 5 ml contains: Ambroxol Hydrochloride IP 30 mg", 20],
        ["100 ml", 40],
        ["MRP Rs 95", 24],
      ),
    );
    expect(reading).toMatchObject({ name: "Cofset", unit: "syrup", packSize: "100ml", mrp: 95, mrpForPieces: 1 });
  });

  it("says so when the MRP basis is assumed", () => {
    const reading = parsePackText(
      lines(["Cetzine", 90], ["Cetirizine Tablets IP 10 mg", 30], ["10 x 10", 20], ["MRP Rs. 25.00", 20]),
    );
    expect(reading.mrpForPieces).toBe(10);
    expect(reading.note).toContain("per strip of 10");
  });

  it("refuses a photo that is not a medicine", () => {
    const reading = parsePackText(lines(["Happy Birthday", 100], ["Love from all of us", 30]));
    expect(reading.isMedicinePack).toBe(false);
    expect(reading.note).toMatch(/does not look like a medicine pack/);
  });
});

describe("pricesFrom", () => {
  it("finds rate and MRP on a bill line by qty x rate = amount", () => {
    // qty, rate, MRP, amount
    expect(pricesFrom([10, 12.5, 15, 125])).toEqual({ purchasePrice: 12.5, mrp: 15 });
    // qty, free, rate, amount - no MRP column
    expect(pricesFrom([20, 2, 4.25, 85])).toEqual({ purchasePrice: 4.25, mrp: null });
  });

  it("reads a price list's one or two numbers", () => {
    expect(pricesFrom([25])).toEqual({ purchasePrice: null, mrp: 25 });
    expect(pricesFrom([30, 22.5])).toEqual({ purchasePrice: 22.5, mrp: 30 });
  });
});

describe("parseListLine", () => {
  it("keeps a brand strength in the name instead of reading it as a price", () => {
    const one = parseListLine("PANTOP 40 TAB 85.00");
    expect(one?.name).toBe("PANTOP 40 TAB");
    expect(one?.purchasePrice).toBeNull();
    expect(one?.mrp).toBe(85);
    const two = parseListLine("PANTOP 40 TAB 65.50 85.00");
    expect([two?.name, two?.purchasePrice, two?.mrp]).toEqual(["PANTOP 40 TAB", 65.5, 85]);
  });

  it("does not mistake a count for a strength once the name has one", () => {
    expect(parseListLine("Cetzine 10mg 10 tab 12.50")?.name).toBe("Cetzine 10mg");
  });

  it("reads a supplier bill line", () => {
    expect(parseListLine("1. Cetzine 10mg 10x10 B2345 12/27 10 12.50 15.00 125.00")).toEqual({
      name: "Cetzine 10mg",
      generic: "",
      manufacturer: "",
      category: "",
      unit: "",
      packSize: "10x10",
      purchasePrice: 12.5,
      mrp: 15,
    });
  });

  it("moves the dosage form to the unit and knows the generic", () => {
    const row = parseListLine("Tab Paracetamol 500 mg 1x10 20 1.50 30.00");
    expect(row).toMatchObject({
      name: "Paracetamol 500mg",
      generic: "Paracetamol",
      category: "Analgesic",
      unit: "tablet",
      packSize: "1x10",
      purchasePrice: 1.5,
    });
  });

  it("skips headings, totals and noise", () => {
    expect(parseListLine("S.N. Particulars Qty Rate Amount")).toBeNull();
    expect(parseListLine("Grand Total 4,520.00")).toBeNull();
    expect(parseListLine("VAT 13% 520.00")).toBeNull();
    expect(parseListLine("--- 12 ---")).toBeNull();
  });

  it("keeps a brand that starts like a heading word", () => {
    expect(parseListLine("No-Spa 40mg 25")?.name).toBe("No-Spa 40mg");
  });
});

describe("parseListText", () => {
  it("gives rows the import parser accepts", () => {
    const { rows, note } = parseListText(
      lines(
        ["ABC Pharma Distributors", 40],
        ["S.N. Particulars Pack Qty Rate MRP Amount", 20],
        ["1 Cetzine 10mg 10x10 10 12.50 15.00 125.00", 20],
        ["2 Pantop 40 10x10 5 110.00 150.00 550.00", 20, 50],
        ["Total 675.00", 20],
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(["Cetzine 10mg", "Pantop 40"]);
    expect(note).toContain("1 line was hard to read");

    const plan = parseMedicineCsv(photoRowsToCsv(rows).csv);
    expect(plan.errorCount).toBe(0);
    expect(plan.rows[1]?.value).toMatchObject({ name: "Pantop 40", defaultCostPrice: 110, defaultSalePrice: 150 });
  });
});
