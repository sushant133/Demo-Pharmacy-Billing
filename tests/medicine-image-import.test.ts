import { describe, expect, it } from "vitest";
import { imageRowsToCsv } from "@/lib/medicine-image-import";
import { parseMedicineCsv } from "@/lib/medicine-import";

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
