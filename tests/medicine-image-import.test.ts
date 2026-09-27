import { describe, expect, it } from "vitest";
import { imageRowsToCsv, packReadingToFill } from "@/lib/medicine-image-import";
import { cleanPrice, parseMedicineCsv, photoRowsToCsv, typedPrice } from "@/lib/medicine-import";

const row = (patch: Partial<Parameters<typeof imageRowsToCsv>[0][number]> = {}) => ({
  name: "Cetzine 10mg",
  generic: "Cetirizine",
  manufacturer: "Deurali-Janta",
  category: "Antihistamine",
  unit: "Tablet",
  packSize: "10x10",
  purchasePrice: 1.2,
  mrp: 2.5,
  ...patch,
});

describe("imageRowsToCsv", () => {
  it("produces import text the existing parser maps column for column", () => {
    const { csv, count } = imageRowsToCsv([row()]);
    expect(count).toBe(1);

    const plan = parseMedicineCsv(csv);
    expect(plan.ignored).toEqual([]);
    expect(plan.errorCount).toBe(0);
    expect(plan.rows[0]?.value).toMatchObject({
      name: "Cetzine 10mg",
      genericName: "Cetirizine",
      manufacturer: "Deurali-Janta",
      category: "Antihistamine",
      unit: "tablet",
      packSize: "10x10",
      defaultCostPrice: 1.2,
      defaultSalePrice: 2.5,
    });
  });

  it("leaves unknown prices blank rather than zero", () => {
    const plan = parseMedicineCsv(imageRowsToCsv([row({ purchasePrice: null, mrp: null })]).csv);
    expect(plan.rows[0]?.value).toMatchObject({ defaultCostPrice: null, defaultSalePrice: null });
  });

  it("drops lines with no name and keeps commas inside names intact", () => {
    const { csv, count } = imageRowsToCsv([
      row({ name: "  " }),
      row({ name: "Augmentin 625mg", generic: "Amoxicillin 500mg, Clavulanic Acid 125mg" }),
    ]);
    expect(count).toBe(1);
    const plan = parseMedicineCsv(csv);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.value).toMatchObject({
      name: "Augmentin 625mg",
      genericName: "Amoxicillin 500mg, Clavulanic Acid 125mg",
    });
  });
});

describe("photoRowsToCsv line numbers", () => {
  it("puts ticked row i on line i + 2, as the review table assumes", () => {
    const rows = [row({ name: "A 1" }), row({ name: "B 2" }), row({ name: "C 3", mrp: "12.50" })];
    const plan = parseMedicineCsv(photoRowsToCsv(rows).csv);
    expect(plan.rows.map((entry) => [entry.line, entry.value?.name])).toEqual([
      [2, "A 1"],
      [3, "B 2"],
      [4, "C 3"],
    ]);
    expect(plan.rows[2]?.value).toMatchObject({ defaultSalePrice: 12.5 });
  });

  it("strips anything but digits and a point from typed prices", () => {
    const plan = parseMedicineCsv(photoRowsToCsv([row({ purchasePrice: "Rs. 1,20", mrp: "" })]).csv);
    expect(plan.rows[0]?.value).toMatchObject({ defaultCostPrice: 120, defaultSalePrice: null });
  });
});

describe("packReadingToFill", () => {
  const reading = (patch: Partial<Parameters<typeof packReadingToFill>[0]> = {}) => ({
    isMedicinePack: true,
    name: "Pantop 40",
    genericName: "Pantoprazole",
    saltComposition: "Pantoprazole Sodium 40mg",
    manufacturer: "Aristo",
    category: "Antacid",
    unit: "Tablet",
    packSize: "10x10",
    barcode: "8 901234 567890",
    unitsPerStrip: 10,
    mrp: 150,
    mrpForPieces: 10,
    note: "",
    ...patch,
  });

  it("turns a strip MRP into a per-piece one and says how", () => {
    const fill = packReadingToFill(reading());
    expect(fill.defaultSalePrice).toBe(15);
    expect(fill.mrpNote).toMatch(/Rs\. 150 for 10 → Rs\. 15\.00 each/);
    expect(fill.unit).toBe("tablet");
    expect(fill.barcode).toBe("8901234567890");
  });

  it("keeps a whole-item MRP as it is", () => {
    const fill = packReadingToFill(reading({ unit: "syrup", mrp: 185, mrpForPieces: 1, unitsPerStrip: null }));
    expect(fill.defaultSalePrice).toBe(185);
    expect(fill.mrpNote).toBe("");
  });

  it("drops a half-read barcode and an impossible strip size", () => {
    const fill = packReadingToFill(reading({ barcode: "8901", unitsPerStrip: 0 }));
    expect(fill.barcode).toBe("");
    expect(fill.unitsPerStrip).toBeNull();
  });
});

describe("price cleaning", () => {
  it("reads prices as written or typed", () => {
    expect(cleanPrice("Rs. 1,250.50")).toBe("1250.50");
    expect(cleanPrice("NPR 15")).toBe("15");
    expect(cleanPrice(2.5)).toBe("2.5");
    expect(cleanPrice(null)).toBe("");
    expect(typedPrice(".5")).toBe("0.5");
    expect(typedPrice("2.7.5")).toBe("2.75");
    expect(typedPrice("12a")).toBe("12");
    expect(typedPrice("3.")).toBe("3.");
  });
});
