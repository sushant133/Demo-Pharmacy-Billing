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

describe("storedBillNo", () => {
  it("looks up the printed slash form against the stored hyphen form", () => {
    expect(displayBillNo("INV-2082-83-000173")).toBe("INV-2082/83-000173");
    expect(storedBillNo("INV-2082/83-000173")).toBe("INV-2082-83-000173");
    expect(storedBillNo("inv-2082-83-000173")).toBe("INV-2082-83-000173");
  });
});
