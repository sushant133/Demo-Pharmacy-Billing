import { describe, expect, it } from "vitest";
import { MEDICINE_CATEGORIES, mergeMedicineCategories } from "@/lib/constants";
import { brandLetter } from "@/lib/format";
import {
  DEFAULT_SETTINGS,
  PLATFORM_IDENTITY_FIELDS,
  issuerFor,
  platformIdentity,
  vatPercent,
} from "@/lib/settings";
import { settingsSchema, updatePharmacySchema } from "@/lib/validation";

const valid = {
  vatRate: 13,
};

/**
 * Who may write what.
 *
 * The registered identity - both names, the PAN, the VAT number, the company
 * registration and the drug licence - is the platform's. The shop reads it
 * and keeps everything else. The guarantee is not a disabled input, which any
 * browser can re-enable: it is that `settingsSchema` has no field for those
 * values at all, so a hand-rolled request carrying one gets nowhere.
 */
describe("the shop cannot write its own registered identity", () => {
  it("drops every locked field from a settings save", () => {
    const parsed = settingsSchema.parse({
      vatRate: 13,
      address: "Baneshwor",
      businessName: "Not My Pharmacy",
      legalName: "Not My Pharmacy Pvt. Ltd.",
      pan: "999999999",
      vatNumber: "999999999",
      vatRegistered: false,
      registrationNo: "FAKE-1",
      drugLicenceNo: "FAKE-2",
    });

    for (const field of PLATFORM_IDENTITY_FIELDS) {
      expect(parsed, field).not.toHaveProperty(field);
    }
    // What the shop does own still comes through.
    expect(parsed.address).toBe("Baneshwor");
    expect(parsed.vatRate).toBe(13);
  });

  it("saves with nothing filled in at all", () => {
    // No field is required: an owner setting the system up should not be
    // blocked at the first screen for want of a line they have to look up.
    const parsed = settingsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.vatRate).toBe(13);
      expect(parsed.data.address).toBe("");
    }
  });

  it("hands a screen exactly the locked half to display", () => {
    const identity = platformIdentity({
      ...DEFAULT_SETTINGS,
      businessName: "Sagarmatha Pharmacy",
      pan: "301234567",
      vatNumber: "301234567",
      drugLicenceNo: "DDA/1234/080",
      address: "Baneshwor",
    });

    expect(Object.keys(identity).sort()).toEqual([...PLATFORM_IDENTITY_FIELDS].sort());
    expect(identity.pan).toBe("301234567");
    expect(identity).not.toHaveProperty("address");
  });
});

/**
 * Superadmin's side of the same split. These fields moved here from the
 * shop's form, so the rules that used to guard them have to have moved too.
 */
describe("updatePharmacySchema", () => {
  const minimum = { name: "Sagarmatha Pharmacy" };

  it("carries the identity the bill is headed with", () => {
    const parsed = updatePharmacySchema.parse({
      ...minimum,
      legalName: "Sagarmatha Pharmacy Pvt. Ltd.",
      pan: "301234567",
      vatNumber: "301234567",
      drugLicenceNo: "DDA/1234/080",
      registrationNo: "123456/080-081",
    });
    expect(parsed.pan).toBe("301234567");
    expect(parsed.vatNumber).toBe("301234567");
    expect(parsed.vatRegistered).toBe(true);
  });

  it("accepts a nine-digit PAN and nothing else", () => {
    for (const pan of ["12345678", "1234567890", "30123456A", "301 234 567"]) {
      expect(updatePharmacySchema.safeParse({ ...minimum, pan }).success, pan).toBe(
        false,
      );
    }
    expect(updatePharmacySchema.safeParse({ ...minimum, pan: "301234567" }).success).toBe(
      true,
    );
  });

  it("holds the VAT number to the same shape as the PAN", () => {
    expect(
      updatePharmacySchema.safeParse({ ...minimum, vatNumber: "30123456" }).success,
    ).toBe(false);
    expect(
      updatePharmacySchema.safeParse({ ...minimum, vatNumber: "301234567" }).success,
    ).toBe(true);
  });

  it("treats a blank PAN as not yet filled in, not as an error", () => {
    // The bill warns about a missing PAN where it matters. Refusing to open
    // an account because the paperwork has not arrived would just mean an
    // invented number gets typed in instead.
    expect(updatePharmacySchema.safeParse({ ...minimum, pan: "" }).success).toBe(true);
  });

  it("records a PAN-only business", () => {
    const parsed = updatePharmacySchema.parse({ ...minimum, vatRegistered: false });
    expect(parsed.vatRegistered).toBe(false);
  });

  it("trims what people paste in", () => {
    const parsed = updatePharmacySchema.parse({
      name: "  Corner Chemist  ",
      pan: " 301234567 ",
    });
    expect(parsed.name).toBe("Corner Chemist");
    expect(parsed.pan).toBe("301234567");
  });

  it("refuses a name too short to be one", () => {
    expect(updatePharmacySchema.safeParse({ name: "A" }).success).toBe(false);
    expect(updatePharmacySchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("settingsSchema", () => {
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
    const parsed = settingsSchema.parse({ ...valid, address: "  Baneshwor  " });
    expect(parsed.address).toBe("Baneshwor");
  });
});

describe("medicineCategories", () => {
  it("accepts extra names on settings", () => {
    const parsed = settingsSchema.parse({
      ...valid,
      medicineCategories: [" Ayurvedic ", "Veterinary"],
    });
    expect(parsed.medicineCategories).toEqual(["Ayurvedic", "Veterinary"]);
  });

  it("defaults to none extra", () => {
    expect(settingsSchema.parse(valid).medicineCategories).toEqual([]);
    expect(DEFAULT_SETTINGS.medicineCategories).toEqual([]);
  });
});

describe("mergeMedicineCategories", () => {
  it("keeps the built-in list, adds extras, and puts Other last", () => {
    const merged = mergeMedicineCategories(["Ayurvedic", "antibiotic", ""]);
    expect(merged[merged.length - 1]).toBe("Other");
    expect(merged).toContain("Ayurvedic");
    expect(merged.filter((name) => name.toLowerCase() === "antibiotic")).toHaveLength(1);
    expect(MEDICINE_CATEGORIES).toContain("Other");
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

describe("brandLetter", () => {
  it("is the first letter of the pharmacy name", () => {
    expect(brandLetter("Sagarmatha Pharmacy")).toBe("S");
    expect(brandLetter("himalaya chemist")).toBe("H");
  });

  it("does not invent a platform initial when the name is blank", () => {
    expect(brandLetter("")).toBe("P");
    expect(brandLetter("   ")).toBe("P");
  });
});

/**
 * Whether a shop is VAT registered decides whether a VAT line prints on a tax
 * invoice, so the flag has to survive the trip through a form intact.
 * `z.coerce.boolean()` would not: it reads the string "false" as true.
 */
describe("the VAT registration flag", () => {
  const parse = (value: unknown) =>
    updatePharmacySchema.parse({ name: "Sagarmatha Pharmacy", vatRegistered: value })
      .vatRegistered;

  it("takes a real boolean at its word", () => {
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
  });

  it("reads the strings a form or a query string sends", () => {
    for (const truthy of ["true", "1", "yes", "on", "On", " TRUE "]) {
      expect(parse(truthy), truthy).toBe(true);
    }
    for (const falsy of ["false", "0", "no", "off", "", "  "]) {
      expect(parse(falsy), falsy).toBe(false);
    }
  });

  it("defaults to registered when nothing is said", () => {
    expect(parse(undefined)).toBe(true);
    expect(parse(null)).toBe(true);
    expect(updatePharmacySchema.parse({ name: "Sagarmatha Pharmacy" }).vatRegistered).toBe(
      true,
    );
  });
});
