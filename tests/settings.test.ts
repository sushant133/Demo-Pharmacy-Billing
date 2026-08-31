import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, issuerFor, vatPercent } from "@/lib/settings";
import { settingsSchema } from "@/lib/validation";

const valid = {
  businessName: "Sagarmatha Pharmacy",
  pan: "301234567",
  vatNumber: "301234567",
  vatRate: 13,
};

describe("settingsSchema", () => {
  it("needs only the pharmacy name", () => {
    const parsed = settingsSchema.safeParse({ businessName: "Corner Chemist" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pan).toBe("");
      expect(parsed.data.vatRate).toBe(13);
      expect(parsed.data.vatRegistered).toBe(true);
    }
  });

  it("refuses a name too short to be one", () => {
    expect(settingsSchema.safeParse({ businessName: "A" }).success).toBe(false);
    expect(settingsSchema.safeParse({ businessName: "  " }).success).toBe(false);
  });

  it("accepts a nine-digit PAN and nothing else", () => {
    expect(settingsSchema.safeParse(valid).success).toBe(true);
    for (const pan of ["12345678", "1234567890", "30123456A", "301 234 567"]) {
      const parsed = settingsSchema.safeParse({ ...valid, pan });
      expect(parsed.success, pan).toBe(false);
    }
  });

  it("treats a blank PAN as not yet filled in, not as an error", () => {
    // The bill warns about a missing PAN where it matters. Refusing to save
    // the shop's name because the owner has not found the PAN certificate
    // yet would just stop them using the screen.
    expect(settingsSchema.safeParse({ ...valid, pan: "" }).success).toBe(true);
  });

  it("holds the VAT rate to a sane percentage", () => {
    expect(settingsSchema.safeParse({ ...valid, vatRate: 0 }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...valid, vatRate: 100 }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...valid, vatRate: -1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...valid, vatRate: 101 }).success).toBe(false);
  });

  it("takes the VAT rate as the string a form sends", () => {
    const parsed = settingsSchema.safeParse({ ...valid, vatRate: "13" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vatRate).toBe(13);
  });

  it("checks an email only when one is given", () => {
    expect(settingsSchema.safeParse({ ...valid, email: "" }).success).toBe(true);
    expect(
      settingsSchema.safeParse({ ...valid, email: "shop@example.com" }).success,
    ).toBe(true);
    expect(settingsSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("trims what people paste in", () => {
    const parsed = settingsSchema.safeParse({
      businessName: "  Corner Chemist  ",
      pan: " 301234567 ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.businessName).toBe("Corner Chemist");
      expect(parsed.data.pan).toBe("301234567");
    }
  });
});

describe("vatPercent", () => {
  it("reads the stored fraction back as a percentage", () => {
    expect(vatPercent({ ...DEFAULT_SETTINGS, vatRate: 0.13 })).toBe(13);
    expect(vatPercent({ ...DEFAULT_SETTINGS, vatRate: 0 })).toBe(0);
    expect(vatPercent({ ...DEFAULT_SETTINGS, vatRate: 0.075 })).toBe(7.5);
  });
});

describe("issuerFor", () => {
  const shop = {
    ...DEFAULT_SETTINGS,
    businessName: "Sagarmatha Pharmacy",
    pan: "301234567",
    address: "Baneshwor",
    city: "Kathmandu",
    phone: "01-4567890",
  };

  it("prints the shop's own details when there is one outlet", () => {
    expect(issuerFor(shop, null)).toEqual({
      name: "Sagarmatha Pharmacy",
      address: "Baneshwor, Kathmandu",
      phone: "01-4567890",
      pan: "301234567",
    });
  });

  it("lets a branch print its own identity", () => {
    // A VAT invoice must carry the identity of the outlet that issued it.
    const issuer = issuerFor(shop, {
      name: "Sagarmatha Pharmacy, Pokhara",
      address: "Lakeside",
      phone: "061-555000",
      panNo: "309999999",
    });
    expect(issuer.name).toBe("Sagarmatha Pharmacy, Pokhara");
    expect(issuer.pan).toBe("309999999");
  });

  it("falls back field by field, not all or nothing", () => {
    // A branch that was named but never given its own PAN files under the
    // shop's. Falling back wholesale would print the wrong outlet's address.
    const issuer = issuerFor(shop, {
      name: "Pokhara counter",
      address: "",
      phone: "",
      panNo: "",
    });
    expect(issuer.name).toBe("Pokhara counter");
    expect(issuer.address).toBe("Baneshwor, Kathmandu");
    expect(issuer.phone).toBe("01-4567890");
    expect(issuer.pan).toBe("301234567");
  });

  it("does not leave a stray comma when the city is blank", () => {
    expect(issuerFor({ ...shop, city: "" }, null).address).toBe("Baneshwor");
    expect(issuerFor({ ...shop, address: "" }, null).address).toBe("Kathmandu");
    expect(issuerFor({ ...shop, address: "", city: "" }, null).address).toBe("");
  });
});
