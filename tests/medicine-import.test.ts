import { describe, expect, it } from "vitest";
import {
  jsonToCsv,
  matchColumn,
  parseMedicineCsv,
  splitCsvLine,
} from "@/lib/medicine-import";

describe("splitCsvLine", () => {
  it("splits a plain row", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims surrounding whitespace", () => {
    expect(splitCsvLine(" a , b ")).toEqual(["a", "b"]);
  });

  /*
    The reason this is hand-written rather than `split(",")`. A salt
    composition routinely contains a comma, and naive splitting turns one
    medicine into two nonsense columns - silently, and only for the
    combination drugs.
  */
  it("keeps a quoted comma inside its cell", () => {
    expect(
      splitCsvLine('Amoxyclav,"Amoxicillin 500mg, Clavulanic Acid 125mg",Lomus'),
    ).toEqual([
      "Amoxyclav",
      "Amoxicillin 500mg, Clavulanic Acid 125mg",
      "Lomus",
    ]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(["a", 'say "hi"', "b"]);
  });

  it("keeps empty cells in position", () => {
    expect(splitCsvLine("a,,c")).toEqual(["a", "", "c"]);
    expect(splitCsvLine(",b,")).toEqual(["", "b", ""]);
  });
});

describe("matchColumn", () => {
  it("accepts the spellings a real spreadsheet uses", () => {
    expect(matchColumn("Name")).toBe("name");
    expect(matchColumn("MEDICINE NAME")).toBe("name");
    expect(matchColumn("  brand  ")).toBe("name");
    expect(matchColumn("MRP")).toBe("defaultSalePrice");
    expect(matchColumn("Purchase Price")).toBe("defaultCostPrice");
    expect(matchColumn("purchase_price")).toBe("defaultCostPrice");
    expect(matchColumn("Reorder-Level")).toBe("reorderLevel");
  });

  it("returns null for a column we do not use", () => {
    expect(matchColumn("Shelf")).toBeNull();
    expect(matchColumn("")).toBeNull();
  });
});

describe("parseMedicineCsv", () => {
  it("reads a well-formed file", () => {
    const plan = parseMedicineCsv(
      [
        "Name,Generic,Manufacturer,MRP,Purchase price",
        "Cetzine 10mg,Cetirizine,Deurali-Janta,2.50,1.20",
      ].join("\n"),
    );

    expect(plan.validCount).toBe(1);
    expect(plan.errorCount).toBe(0);

    const row = plan.rows[0]!;
    expect(row.value).toMatchObject({
      name: "Cetzine 10mg",
      genericName: "Cetirizine",
      manufacturer: "Deurali-Janta",
      defaultSalePrice: 2.5,
      defaultCostPrice: 1.2,
    });
  });

  it("reports which columns it ignored", () => {
    const plan = parseMedicineCsv("Name,Shelf,Aisle\nParacetamol,A1,3");
    expect(plan.columns).toContain("name");
    expect(plan.ignored).toEqual(["Shelf", "Aisle"]);
  });

  /*
    A 400-line spreadsheet will have three bad rows. Refusing the lot over them
    means the shop gives up and types it all in by hand, so a bad row is
    reported with its line number and skipped.
  */
  it("keeps good rows when a bad one is among them", () => {
    const plan = parseMedicineCsv(
      ["Name,MRP", "Cetzine,2.50", ",9.00", "Omez,4.00"].join("\n"),
    );

    expect(plan.validCount).toBe(2);
    expect(plan.errorCount).toBe(1);
    expect(plan.rows[1]!.error).toMatch(/no medicine name/i);
  });

  it("numbers errors by the line the user sees in their file", () => {
    // Header is line 1, so the first data row is line 2.
    const plan = parseMedicineCsv(["Name,MRP", "Cetzine,2.50", ",9"].join("\n"));
    expect(plan.rows[0]!.line).toBe(2);
    expect(plan.rows[1]!.line).toBe(3);
  });

  it("reads the yes/no spellings a spreadsheet uses for Rx", () => {
    const plan = parseMedicineCsv(
      ["Name,Rx", "Azithral,Yes", "Cetzine,no", "Omez,1", "Pantop,"].join("\n"),
    );
    expect(plan.validCount).toBe(4);
    expect(plan.rows.map((row) => row.value?.requiresPrescription)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("refuses a name too short to be a medicine", () => {
    // The same floor the add form enforces, so an import cannot put a row in
    // the catalogue that the edit panel would then refuse to save.
    const plan = parseMedicineCsv("Name\nA");
    expect(plan.errorCount).toBe(1);
    expect(plan.rows[0]!.error).toMatch(/name/i);
  });

  it("turns a blank price into null, not zero", () => {
    // Zero is a price somebody could deliberately set; blank is not an answer.
    const plan = parseMedicineCsv("Name,MRP,Purchase price\nCetzine,,");
    expect(plan.rows[0]!.value).toMatchObject({
      defaultSalePrice: null,
      defaultCostPrice: null,
    });
  });

  it("refuses a negative price rather than importing it", () => {
    const plan = parseMedicineCsv("Name,MRP\nCetzine,-5");
    expect(plan.errorCount).toBe(1);
    expect(plan.rows[0]!.error).toMatch(/negative/i);
  });

  it("ignores blank lines anywhere in the file", () => {
    const plan = parseMedicineCsv("Name\n\nCetzine\n\n\nOmez\n");
    expect(plan.validCount).toBe(2);
  });

  it("returns an empty plan for an empty file", () => {
    expect(parseMedicineCsv("").rows).toHaveLength(0);
    expect(parseMedicineCsv("   \n  ").rows).toHaveLength(0);
  });

  it("reads a header with no data rows as nothing to import", () => {
    const plan = parseMedicineCsv("Name,MRP");
    expect(plan.rows).toHaveLength(0);
    expect(plan.columns).toContain("name");
  });
});

describe("file structure detection", () => {
  it("reads tab-separated rows pasted from Excel", () => {
    const plan = parseMedicineCsv("Name\tMRP\nCetzine\t2.50");
    expect(plan.rows[0]!.value).toMatchObject({ name: "Cetzine", defaultSalePrice: 2.5 });
  });

  it("reads semicolon-separated CSV", () => {
    const plan = parseMedicineCsv("Name;Generic\nCetzine;Cetirizine");
    expect(plan.rows[0]!.value).toMatchObject({ genericName: "Cetirizine" });
  });

  it("finds the heading row below a title line", () => {
    const plan = parseMedicineCsv("Shree Pharmacy stock list\nName,MRP\nCetzine,2.50");
    expect(plan.validCount).toBe(1);
    expect(plan.rows[0]!.line).toBe(3);
  });

  it("matches decorated and camelCase headings", () => {
    expect(matchColumn("MRP (Rs.)")).toBe("defaultSalePrice");
    expect(matchColumn("genericName")).toBe("genericName");
    expect(matchColumn("Pack Size:")).toBe("packSize");
  });

  it("reports how each heading was mapped", () => {
    const plan = parseMedicineCsv("Medicine Name,Shelf\nCetzine,A1");
    expect(plan.mapping).toEqual([
      { header: "Medicine Name", field: "name" },
      { header: "Shelf", field: null },
    ]);
  });

  it("takes a blank or plural unit as the form it means", () => {
    const plan = parseMedicineCsv("Name,Unit,Category\nCetzine,,\nOmez,Capsules,\nZinc,SYP,");
    expect(plan.rows.map((row) => row.value?.unit)).toEqual(["tablet", "capsule", "syrup"]);
    expect(plan.rows[0]!.value?.category).toBe("Other");
  });
});

describe("JSON import", () => {
  it("reads an array of medicine objects", () => {
    const plan = parseMedicineCsv(
      JSON.stringify([
        { name: "Cetzine", genericName: "Cetirizine", mrp: 2.5, rx: false },
        { name: "Amoxyclav", saltComposition: "Amoxicillin 500mg, Clavulanic Acid 125mg" },
      ]),
    );
    expect(plan.validCount).toBe(2);
    expect(plan.rows[0]!.value).toMatchObject({ genericName: "Cetirizine", defaultSalePrice: 2.5 });
    expect(plan.rows[1]!.value).toMatchObject({
      saltComposition: "Amoxicillin 500mg, Clavulanic Acid 125mg",
    });
  });

  it("reads a list wrapped in an object", () => {
    expect(jsonToCsv(JSON.stringify({ medicines: [{ name: "Cetzine" }] }))).toBe(
      "name\nCetzine",
    );
  });

  it("refuses JSON that is not valid", () => {
    expect(() => parseMedicineCsv("[{name:")).toThrow(/json/i);
  });
});
