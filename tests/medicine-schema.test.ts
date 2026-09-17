import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Medicine } from "@/models/Medicine";
import { storedBillNo, displayBillNo } from "@/models/Counter";
import { medicineSchema } from "@/lib/validation";

describe("Medicine.unitsPerStrip", () => {
  it("allows a bottle or a tablet with no strip size set", () => {
    const syrup = new Medicine({
      pharmacyId: new Types.ObjectId(),
      name: "Cough syrup",
      unit: "syrup",
      unitsPerStrip: null,
    });
    expect(syrup.validateSync()?.errors.unitsPerStrip).toBeUndefined();
  });

  it("accepts a Pantop-style strip of 10", () => {
    const tablet = new Medicine({
      pharmacyId: new Types.ObjectId(),
      name: "Pantop 40mg",
      unit: "tablet",
      unitsPerStrip: 10,
    });
    expect(tablet.validateSync()?.errors.unitsPerStrip).toBeUndefined();
  });

  it("rejects zero or a fraction", () => {
    const zero = new Medicine({
      pharmacyId: new Types.ObjectId(),
      name: "Pantop 40mg",
      unitsPerStrip: 0,
    });
    expect(zero.validateSync()?.errors.unitsPerStrip).toBeTruthy();

    const fraction = new Medicine({
      pharmacyId: new Types.ObjectId(),
      name: "Pantop 40mg",
      unitsPerStrip: 2.5,
    });
    expect(fraction.validateSync()?.errors.unitsPerStrip).toBeTruthy();
  });
});

describe("medicineSchema reorderLevel", () => {
  it("treats a blank reorder level as the shop default, not zero", () => {
    const parsed = medicineSchema.parse({
      name: "Pantop 40mg",
      unit: "tablet",
      reorderLevel: "",
    });
    expect(parsed.reorderLevel).toBeNull();
  });
});

describe("medicineSchema sku", () => {
  const base = { name: "Amoxil 500mg", unit: "capsule" as const };

  it("upper-cases the code, so one product cannot be filed under two", () => {
    expect(medicineSchema.parse({ ...base, sku: "amx-500" }).sku).toBe("AMX-500");
    expect(medicineSchema.parse({ ...base, sku: " amx-500 " }).sku).toBe("AMX-500");
  });

  it("defaults to blank for a shop that does not use codes", () => {
    expect(medicineSchema.parse(base).sku).toBe("");
    expect(medicineSchema.parse({ ...base, sku: "" }).sku).toBe("");
    expect(medicineSchema.parse({ ...base, sku: "   " }).sku).toBe("");
  });

  it("accepts the punctuation shelf codes actually use", () => {
    for (const code of ["AMX500", "AMX-500", "AMX.500", "AMX_500", "A/500", "12345"]) {
      expect(medicineSchema.parse({ ...base, sku: code }).sku).toBe(code);
    }
  });

  it("rejects a code with spaces or symbols that would not scan or sort", () => {
    for (const code of ["AMX 500", "AMX#500", "-AMX", "amx@500"]) {
      expect(medicineSchema.safeParse({ ...base, sku: code }).success).toBe(false);
    }
  });

  it("rejects a code too long for a shelf label", () => {
    expect(
      medicineSchema.safeParse({ ...base, sku: "A".repeat(41) }).success,
    ).toBe(false);
    expect(
      medicineSchema.safeParse({ ...base, sku: "A".repeat(40) }).success,
    ).toBe(true);
  });

  it("stores the code upper-cased on the document too", () => {
    const medicine = new Medicine({
      pharmacyId: new Types.ObjectId(),
      name: "Amoxil 500mg",
      sku: "amx-500",
    });
    expect(medicine.sku).toBe("AMX-500");
  });
});

describe("storedBillNo", () => {
  it("looks up the printed slash form against the stored hyphen form", () => {
    expect(displayBillNo("INV-2082-83-000173")).toBe("INV-2082/83-000173");
    expect(storedBillNo("INV-2082/83-000173")).toBe("INV-2082-83-000173");
    expect(storedBillNo("inv-2082-83-000173")).toBe("INV-2082-83-000173");
  });
});
