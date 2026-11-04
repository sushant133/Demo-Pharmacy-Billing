import { describe, expect, it } from "vitest";
import { missingCbmsRows } from "@/lib/cbms";
import {
  defaultVatExempt,
  isControlledSchedule,
  medicineSchedule,
} from "@/lib/constants";
import { registerLines, type RegisterEvent } from "@/lib/controlled-register";
import { calculateTotals } from "@/lib/fefo";
import { billFileKind, tidyExpiry } from "@/lib/bill-import";
import { matchCatalogue, strengthsConflict } from "@/lib/medicine-ocr";
import { parseMedicineCsv } from "@/lib/medicine-import";
import { roleName } from "@/lib/roles";
import {
  branchSchema,
  controlledSaleSchema,
  createSaleSchema,
  customerSchema,
  medicineSchema,
} from "@/lib/validation";
import { findSequenceGaps } from "@/models/Counter";
import { Medicine } from "@/models/Medicine";

describe("medicines are VAT exempt unless someone says otherwise", () => {
  it("defaults on in the schema and the model", () => {
    expect(medicineSchema.parse({ name: "Cetzine 10mg" }).vatExempt).toBe(true);
    expect(new Medicine({ name: "Cetzine 10mg" }).vatExempt).toBe(true);
  });

  it("keeps an explicit no", () => {
    expect(medicineSchema.parse({ name: "Face cream", vatExempt: false }).vatExempt).toBe(false);
  });

  it("starts non-medicine categories as taxable", () => {
    expect(defaultVatExempt("Antibiotic")).toBe(true);
    expect(defaultVatExempt("Other")).toBe(true);
    expect(defaultVatExempt(undefined)).toBe(true);
    expect(defaultVatExempt("Supplement")).toBe(false);
    expect(defaultVatExempt("Cosmetics")).toBe(false);
    expect(defaultVatExempt("Medical device")).toBe(false);
  });

  it("starts toiletries as taxable from the name alone, as bills give no category", () => {
    expect(defaultVatExempt(null, "G-MAX SOAP75GM")).toBe(false);
    expect(defaultVatExempt(null, "ACNIFAIR FACEWASH 60ML")).toBe(false);
    expect(defaultVatExempt(null, "G-MAX-C LOTION")).toBe(false);
    expect(defaultVatExempt(null, "PANTOP 40 TAB")).toBe(true);
  });

  it("splits a mixed bill so VAT falls only on the taxable line", () => {
    const totals = calculateTotals({
      grossSubtotal: 300,
      discount: 0,
      discountPercent: 0,
      vatRate: 0.13,
      exemptSubtotal: 200,
    });
    expect(totals.exemptAmount).toBe(200);
    expect(totals.vatAmount).toBe(13);
    expect(totals.totalAmount).toBe(313);
  });
});

describe("medicine import", () => {
  const rows = (plan: ReturnType<typeof parseMedicineCsv>) =>
    plan.rows.map((row) => row.value as Record<string, unknown>);

  it("treats a sheet with no VAT column the way the add form does", () => {
    const plan = parseMedicineCsv(
      "name,category\nCetzine,Antihistamine\nProtein powder,Supplement",
    );
    expect(rows(plan).map((row) => row.vatExempt)).toEqual([true, false]);
  });

  it("honours a VAT column that answers", () => {
    const plan = parseMedicineCsv("name,vat exempt\nCetzine,no\nCough syrup,yes");
    expect(rows(plan).map((row) => row.vatExempt)).toEqual([false, true]);
  });

  it("starts a toiletry on a sheet with no VAT column as taxable", () => {
    const plan = parseMedicineCsv("name\nG-MAX SOAP75GM\nCetzine");
    expect(rows(plan).map((row) => row.vatExempt)).toEqual([false, true]);
  });

  it("refuses a schedule it cannot place, rather than dropping a controlled drug", () => {
    const plan = parseMedicineCsv("name,controlled\nMorphine 10mg,Yes\nCetzine,No\nAlprazolam,Psychotropic");
    expect(plan.rows[0]!.value).toBeNull();
    expect(plan.rows[0]!.error).toContain("Narcotic, Psychotropic, Rx or OTC");
    expect(plan.rows[1]!.error).toBeNull();
    expect((plan.rows[2]!.value as Record<string, unknown>).schedule).toBe("psychotropic");
  });

  it("reads a schedule column, and a controlled line needs a prescription", () => {
    const plan = parseMedicineCsv(
      "name,schedule\nMorphine 10mg,Narcotic\nAlprazolam 0.5mg,psychotropic\nCetzine,OTC",
    );
    expect(rows(plan).map((row) => row.schedule)).toEqual(["narcotic", "psychotropic", undefined]);
    expect(rows(plan).map((row) => row.requiresPrescription)).toEqual([true, true, false]);
  });
});

describe("billFileKind", () => {
  const excel = "application/vnd.ms-excel";

  it("reads a CSV as text even when Windows calls it an Excel file", () => {
    expect(billFileKind(excel, "bill.csv")).toBe("text");
    expect(billFileKind(excel, "BILL.CSV")).toBe("text");
  });

  it("still sends real workbooks to the workbook reader", () => {
    expect(billFileKind(excel, "bill.xlsx")).toBe("workbook");
    expect(billFileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "bill")).toBe("workbook");
    expect(billFileKind("application/octet-stream", "bill.xlsx")).toBe("workbook");
  });

  it("reads text by its type when the name says nothing, and refuses the rest", () => {
    expect(billFileKind("text/csv", "bill")).toBe("text");
    expect(billFileKind("application/pdf", "bill.pdf")).toBeNull();
  });
});

describe("tidyExpiry reads month names", () => {
  it.each([
    ["Jul-27", "07/2027"],
    ["July 2027", "07/2027"],
    ["Oct-27", "10/2027"],
    ["Nov 2027", "11/2027"],
    ["April 2027", "04/2027"],
    ["Apr-27", "04/2027"],
    ["Sep-27", "09/2027"],
    ["Oct-2O27", "10/2027"],
  ])("%s is %s", (input, expected) => {
    expect(tidyExpiry(input)).toBe(expected);
  });

  it("still repairs numeric dates, and refuses what is not a month", () => {
    expect(tidyExpiry("O4/2O27")).toBe("04/2027");
    expect(tidyExpiry("I2/27")).toBe("12/2027");
    expect(tidyExpiry("Foo-27")).toBe("");
  });
});

describe("matchCatalogue and strength", () => {
  const catalogue = (...names: string[]) => names.map((name) => ({ name }));

  it("does not treat another strength of the same drug as a match", () => {
    expect(matchCatalogue("Paracetamol 500mg", catalogue("Paracetamol 650mg"))).toBeNull();
    expect(matchCatalogue("Tramadol 50mg", catalogue("Tramadol 100mg"))).toBeNull();
    expect(matchCatalogue("Tramadol 50mg", catalogue("Tramadol 500mg"))).toBeNull();
    expect(matchCatalogue("Pantop 40", catalogue("Pantop 20"))).toBeNull();
  });

  it("finds the right strength among several", () => {
    expect(matchCatalogue("Pantop 40", catalogue("Pantop 20", "Pantop 40"))?.name).toBe("Pantop 40");
  });

  it("still forgives a smudged name, and a smudged unit", () => {
    expect(matchCatalogue("Paracetarnol 500mg", catalogue("Paracetamol 500mg"))?.name).toBe("Paracetamol 500mg");
    expect(matchCatalogue("FOITCURE CREA 756M", catalogue("FOOTCURE CREAM 75GM"))?.name).toBe("FOOTCURE CREAM 75GM");
    expect(matchCatalogue("Pantop 40 Tab", catalogue("Pantop 40mg Tab"))?.name).toBe("Pantop 40mg Tab");
  });

  it("still matches when the photo lost the digits altogether", () => {
    expect(matchCatalogue("G-NAX SOAPTSGH", catalogue("G-MAX SOAP75GM"))?.name).toBe("G-MAX SOAP75GM");
  });

  it("knows a misread letter from a real difference", () => {
    expect(strengthsConflict("756M", "75GM")).toBe(false);
    expect(strengthsConflict("100GU", "100GM")).toBe(false);
    expect(strengthsConflict("75", "75GM")).toBe(false);
    expect(strengthsConflict("500MG", "650MG")).toBe(true);
    expect(strengthsConflict("50", "500MG")).toBe(true);
  });
});

describe("medicineSchedule", () => {
  it("reads a record from before the field existed by its Rx flag", () => {
    expect(medicineSchedule({ requiresPrescription: true })).toBe("rx");
    expect(medicineSchedule({ requiresPrescription: false })).toBe("otc");
    expect(medicineSchedule({ schedule: "", requiresPrescription: true })).toBe("rx");
  });

  it("lets a controlled schedule win over the flag", () => {
    expect(medicineSchedule({ schedule: "narcotic", requiresPrescription: false })).toBe("narcotic");
    expect(isControlledSchedule("psychotropic")).toBe(true);
    expect(isControlledSchedule("rx")).toBe(false);
  });
});

describe("the record a controlled sale must carry", () => {
  const complete = {
    patientName: "Hari Thapa",
    prescriberName: "Dr. Sita Rai",
    prescriberNmcNo: "12345",
    prescriptionRef: "File 7",
  };

  it("accepts a filing reference or a photo", () => {
    expect(controlledSaleSchema.safeParse(complete).success).toBe(true);
    expect(
      controlledSaleSchema.safeParse({
        ...complete,
        prescriptionRef: "",
        prescriptionImage: "data:image/jpeg;base64,AAAA",
      }).success,
    ).toBe(true);
  });

  it("refuses neither, and each missing person", () => {
    expect(controlledSaleSchema.safeParse({ ...complete, prescriptionRef: "" }).success).toBe(false);
    expect(controlledSaleSchema.safeParse({ ...complete, patientName: "" }).success).toBe(false);
    expect(controlledSaleSchema.safeParse({ ...complete, prescriberName: "" }).success).toBe(false);
    expect(controlledSaleSchema.safeParse({ ...complete, prescriberNmcNo: "" }).success).toBe(false);
  });

  it("will only store a JPEG", () => {
    expect(
      controlledSaleSchema.safeParse({
        ...complete,
        prescriptionImage: "data:text/html;base64,AAAA",
      }).success,
    ).toBe(false);
  });

  it("is optional on a bill, which only createSale can judge", () => {
    const item = { medicineId: "507f1f77bcf86cd799439011", quantity: 1 };
    expect(createSaleSchema.safeParse({ items: [item], controlled: null }).success).toBe(true);
  });
});

describe("PAN is nine digits everywhere", () => {
  it("on a branch and a customer, or blank", () => {
    for (const [schema, base] of [
      [branchSchema, { code: "main", name: "Main" }],
      [customerSchema, { name: "Ram" }],
    ] as const) {
      expect(schema.safeParse({ ...base, panNo: "3333333333333" }).success).toBe(false);
      expect(schema.safeParse({ ...base, panNo: "301234567" }).success).toBe(true);
      expect(schema.safeParse({ ...base, panNo: "" }).success).toBe(true);
    }
  });
});

describe("findSequenceGaps", () => {
  it("finds nothing in an unbroken series", () => {
    expect(findSequenceGaps([1, 2, 3], 3)).toEqual([]);
    expect(findSequenceGaps([], 0)).toEqual([]);
  });

  it("reports runs between records, in any order", () => {
    expect(findSequenceGaps([1, 6, 2, 9])).toEqual([
      { from: 3, to: 5 },
      { from: 7, to: 8 },
    ]);
  });

  it("reports a missing start", () => {
    expect(findSequenceGaps([3])).toEqual([{ from: 1, to: 2 }]);
  });

  it("catches numbers the counter spent after the last bill", () => {
    expect(findSequenceGaps([1, 2], 5)).toEqual([{ from: 3, to: 5 }]);
  });
});

describe("registerLines", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 0, day));
  const event = (day: number, delta: number, medicineId = "m1"): RegisterEvent => ({
    medicineId,
    at: at(day),
    delta,
    batch: "B1",
  });

  it("walks the running balance from today's stock", () => {
    // 20 now, after +10 then -5 then -3: so it opened at 18.
    const lines = registerLines(
      [event(3, -5), event(1, 10), event(5, -3)],
      new Map([["m1", 20]]),
      at(10),
    );
    expect(lines.map((line) => line.inStock)).toEqual([28, 23, 20]);
  });

  it("counts a sale from before the drug was controlled, without listing it", () => {
    const lines = registerLines(
      [{ ...event(1, -2), unlisted: true }, event(5, -3)],
      new Map([["m1", 15]]),
      at(10),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.inStock).toBe(15);
  });

  it("does not list what happened after the period, but counts it", () => {
    const lines = registerLines([event(1, 10), event(20, -4)], new Map([["m1", 6]]), at(10));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.inStock).toBe(10);
  });

  it("keeps each drug's balance apart", () => {
    const lines = registerLines(
      [event(1, -1, "m1"), event(1, -2, "m2")],
      new Map([
        ["m1", 9],
        ["m2", 8],
      ]),
      at(10),
    );
    expect(lines.find((line) => line.medicineId === "m1")!.inStock).toBe(9);
    expect(lines.find((line) => line.medicineId === "m2")!.inStock).toBe(8);
  });
});

describe("missingCbmsRows", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");

  it("queues a plain bill once", () => {
    expect(missingCbmsRows({ billNo: "INV-1", createdAt })).toEqual([
      { kind: "bill", returnIndex: null, documentNo: "INV-1", issuedAt: createdAt },
    ]);
  });

  it("brings its returns and cancellation with it, bill first", () => {
    const returnedAt = new Date("2026-01-02T00:00:00Z");
    const voidedAt = new Date("2026-01-03T00:00:00Z");
    const rows = missingCbmsRows({
      billNo: "INV-1",
      createdAt,
      voidedAt,
      returns: [{ returnedAt, creditNoteNo: "CN-1" }, { returnedAt }],
    });
    expect(rows.map((row) => [row.kind, row.documentNo])).toEqual([
      ["bill", "INV-1"],
      ["return", "CN-1"],
      ["return", "INV-1/R2"],
      ["cancel", "INV-1-CANCEL"],
    ]);
  });
});

describe("roleName", () => {
  it("shows a role the way the staff screen does", () => {
    expect(roleName("admin")).toBe("Pharmacy owner");
    expect(roleName("something-old")).toBe("something-old");
  });
});
