import { describe, expect, it } from "vitest";
import { money } from "@/lib/format";
import { formatUnitCount, unitWord } from "@/lib/pack";
import { medicineSchema, supplierSchema } from "@/lib/validation";

describe("money", () => {
  it("prints Rs. with two decimals", () => {
    expect(money(500)).toBe("Rs. 500.00");
    expect(money(1234.5)).toBe("Rs. 1,234.50");
    expect(money(null)).toBe("Rs. 0.00");
  });
});

describe("supplierSchema phone", () => {
  const base = { name: "Everest Pharma" };

  it("accepts blank or exactly ten digits", () => {
    expect(supplierSchema.parse({ ...base, phone: "" }).phone).toBe("");
    expect(supplierSchema.parse({ ...base, phone: "9841234567" }).phone).toBe("9841234567");
  });

  it.each(["984123456", "98412345678", "98412-3456", "+9779841234", "98412a4567", "01 4412345"])(
    "refuses %s",
    (phone) => {
      const result = supplierSchema.safeParse({ ...base, phone });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toMatch(/10-digit/);
    },
  );
});

describe("supplierSchema PAN/VAT", () => {
  const base = { name: "Everest Pharma" };

  it("accepts blank or exactly nine digits", () => {
    expect(supplierSchema.parse({ ...base, panNo: "" }).panNo).toBe("");
    expect(supplierSchema.parse({ ...base, panNo: "301234567" }).panNo).toBe("301234567");
  });

  it.each(["30123456", "3012345678", "30123456A", "301-234-567"])("refuses %s", (panNo) => {
    const result = supplierSchema.safeParse({ ...base, panNo });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/9 digits/);
  });
});

describe("supplierSchema email", () => {
  it("accepts a real address and blank, refuses a malformed one", () => {
    expect(supplierSchema.parse({ name: "X Pharma", email: "Orders@Supplier.com.np" }).email).toBe(
      "orders@supplier.com.np",
    );
    expect(supplierSchema.parse({ name: "X Pharma", email: "" }).email).toBe("");
    expect(supplierSchema.safeParse({ name: "X Pharma", email: "orders@" }).success).toBe(false);
  });

  it("leaves partial updates alone", () => {
    // Toggling a supplier active must not trip over fields it did not send.
    expect(supplierSchema.partial().parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe("medicineSchema unit", () => {
  it("keeps a unit the shop added, lowercased", () => {
    expect(medicineSchema.parse({ name: "ORS", unit: "Packet" }).unit).toBe("packet");
    expect(medicineSchema.parse({ name: "Pantop", unit: "tablet" }).unit).toBe("tablet");
  });

  it("falls back to tablet when blank", () => {
    expect(medicineSchema.parse({ name: "Pantop" }).unit).toBe("tablet");
    expect(medicineSchema.parse({ name: "Pantop", unit: "  " }).unit).toBe("tablet");
  });

  it("keeps any category name", () => {
    expect(medicineSchema.parse({ name: "Chyawanprash", category: "Ayurvedic" }).category).toBe(
      "Ayurvedic",
    );
  });
});

describe("unitWord for a unit the shop added", () => {
  it("uses the unit's own name, pluralised", () => {
    expect(formatUnitCount(4, "strip")).toBe("4 strips");
    expect(formatUnitCount(1, "packet")).toBe("1 packet");
    expect(unitWord("box", 2)).toBe("boxes");
    expect(unitWord("", 2)).toBe("units");
  });

  it("leaves the built-in words alone", () => {
    expect(formatUnitCount(3, "syrup")).toBe("3 bottles");
    expect(unitWord("other", 2)).toBe("units");
  });
});
