import { describe, expect, it } from "vitest";
import {
  createPharmacySchema,
  deleteBranchSchema,
  deletePharmacySchema,
  pharmacyStatusSchema,
  updateOwnerSchema,
  updatePharmacySchema,
} from "@/lib/validation";

/**
 * The platform's intake form.
 *
 * The rule worth protecting here is that an account can be opened with a
 * name, a person and a password and nothing else: every licence, PAN and
 * KYC field is optional on purpose, because a form that demands them gets
 * invented values typed into it, and an invented PAN prints on a tax invoice.
 */

const minimum = {
  name: "Sagarmatha Pharmacy",
  ownerName: "Bimala Shrestha",
  ownerEmail: "Bimala@Example.com ",
  ownerPassword: "counter-2082",
};

describe("createPharmacySchema", () => {
  it("opens an account from a name, a person and a password", () => {
    const parsed = createPharmacySchema.parse(minimum);

    expect(parsed.name).toBe("Sagarmatha Pharmacy");
    expect(parsed.ownerEmail).toBe("bimala@example.com");
    expect(parsed.pan).toBe("");
    expect(parsed.registrationNo).toBe("");
    expect(parsed.drugLicenceNo).toBe("");
    expect(parsed.licenceExpiry).toBeNull();
    expect(parsed.ownerCitizenshipNo).toBe("");
    expect(parsed.slug).toBeUndefined();
  });

  it("keeps the paperwork when it is given", () => {
    const parsed = createPharmacySchema.parse({
      ...minimum,
      pan: "123456789",
      registrationNo: "  12345/078  ",
      drugLicenceNo: "DDA-4471",
      licenceExpiry: "2027-03-15",
      ownerCitizenshipNo: "12-01-75-01234",
      ownerPhone: "9800000000",
      email: "Shop@Example.com",
    });

    expect(parsed.pan).toBe("123456789");
    expect(parsed.registrationNo).toBe("12345/078");
    expect(parsed.licenceExpiry?.toISOString().slice(0, 10)).toBe("2027-03-15");
    expect(parsed.ownerCitizenshipNo).toBe("12-01-75-01234");
    expect(parsed.email).toBe("shop@example.com");
  });

  it("refuses a PAN that is not nine digits, but not a blank one", () => {
    expect(createPharmacySchema.safeParse({ ...minimum, pan: "12345" }).success).toBe(
      false,
    );
    expect(
      createPharmacySchema.safeParse({ ...minimum, pan: "12345678A" }).success,
    ).toBe(false);
    expect(createPharmacySchema.safeParse({ ...minimum, pan: "" }).success).toBe(true);
  });

  it("accepts the shapes a real citizenship number comes in", () => {
    for (const value of ["12-01-75-01234", "075/76-1234", "1234567890"]) {
      expect(
        createPharmacySchema.safeParse({ ...minimum, ownerCitizenshipNo: value })
          .success,
      ).toBe(true);
    }
    expect(
      createPharmacySchema.safeParse({
        ...minimum,
        ownerCitizenshipNo: "12<script>",
      }).success,
    ).toBe(false);
  });

  it("still insists on a working login", () => {
    expect(
      createPharmacySchema.safeParse({ ...minimum, ownerEmail: "nope" }).success,
    ).toBe(false);
    expect(
      createPharmacySchema.safeParse({ ...minimum, ownerPassword: "short12" }).success,
    ).toBe(false);
    expect(createPharmacySchema.safeParse({ ...minimum, name: "S" }).success).toBe(
      false,
    );
  });
});

describe("updatePharmacySchema", () => {
  it("carries the same optional profile, and cannot touch the login", () => {
    const parsed = updatePharmacySchema.parse({ name: "Sagarmatha Pharmacy" });

    expect(parsed.pan).toBe("");
    expect(parsed.notes).toBe("");
    expect("ownerEmail" in parsed).toBe(false);
    expect("ownerPassword" in parsed).toBe(false);
  });

  it("clears a field that is blanked rather than ignoring it", () => {
    const parsed = updatePharmacySchema.parse({
      name: "Sagarmatha Pharmacy",
      drugLicenceNo: "",
      licenceExpiry: "",
    });

    expect(parsed.drugLicenceNo).toBe("");
    expect(parsed.licenceExpiry).toBeNull();
  });
});

describe("updateOwnerSchema", () => {
  it("normalises the address the login will be moved to", () => {
    const parsed = updateOwnerSchema.parse({
      ownerName: " Bimala Shrestha ",
      ownerEmail: " NEW@Example.com ",
    });

    expect(parsed.ownerName).toBe("Bimala Shrestha");
    expect(parsed.ownerEmail).toBe("new@example.com");
  });
});

describe("pharmacyStatusSchema", () => {
  it("treats a missing reason as blank rather than refusing the suspension", () => {
    expect(pharmacyStatusSchema.parse({}).reason).toBe("");
    expect(pharmacyStatusSchema.parse({ reason: " unpaid " }).reason).toBe("unpaid");
  });
});

describe("deletePharmacySchema", () => {
  it("demands something typed", () => {
    expect(deletePharmacySchema.safeParse({}).success).toBe(false);
    expect(deletePharmacySchema.safeParse({ confirm: "" }).success).toBe(false);
    expect(deletePharmacySchema.parse({ confirm: " sagarmatha " }).confirm).toBe(
      "sagarmatha",
    );
  });
});

/**
 * Deleting one outlet.
 *
 * Same guard as deleting a pharmacy, for the same reason: the code typed by
 * hand, so the action cannot be reached by a mis-click in a list of rows that
 * all look alike. Everything else that protects a branch - the default flag,
 * and whether anything points at it - is checked against the database in
 * lib/branches.ts, because those are questions a schema cannot answer.
 */
describe("deleteBranchSchema", () => {
  it("insists on a confirmation", () => {
    expect(deleteBranchSchema.safeParse({ confirm: "pokhara" }).success).toBe(true);
    expect(deleteBranchSchema.safeParse({ confirm: "" }).success).toBe(false);
    expect(deleteBranchSchema.safeParse({ confirm: "   " }).success).toBe(false);
    expect(deleteBranchSchema.safeParse({}).success).toBe(false);
  });

  it("trims it, so a pasted code with a trailing space still works", () => {
    const parsed = deleteBranchSchema.parse({ confirm: "  pokhara " });
    expect(parsed.confirm).toBe("pokhara");
  });
});
