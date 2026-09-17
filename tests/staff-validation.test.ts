import { describe, expect, it } from "vitest";
import {
  staffActiveSchema,
  staffPasswordResetSchema,
  staffSchema,
  staffUpdateSchema,
} from "@/lib/validation";
import { ASSIGNABLE_ROLES } from "@/lib/roles";

const BRANCH = "507f1f77bcf86cd799439011";

const base = {
  name: "Sunita Karki",
  email: "Sunita@Example.com ",
  password: "counter-2082",
  role: "cashier" as const,
  branchId: BRANCH,
};

describe("staffSchema", () => {
  it("folds the email to lowercase and trims it", () => {
    const parsed = staffSchema.parse(base);
    expect(parsed.email).toBe("sunita@example.com");
  });

  it("treats a blank branch as no fixed branch", () => {
    expect(staffSchema.parse({ ...base, branchId: "" }).branchId).toBeNull();
    expect(staffSchema.parse({ ...base, branchId: null }).branchId).toBeNull();
    const { branchId: _omitted, ...withoutBranch } = base;
    expect(staffSchema.parse(withoutBranch).branchId).toBeNull();
  });

  it("requires a password long enough to be worth having", () => {
    expect(staffSchema.safeParse({ ...base, password: "short12" }).success).toBe(false);
    expect(staffSchema.safeParse({ ...base, password: "exactly8" }).success).toBe(true);
  });

  it("rejects a name or an address that is not one", () => {
    expect(staffSchema.safeParse({ ...base, name: "S" }).success).toBe(false);
    expect(staffSchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(
      false,
    );
  });

  /*
    The role now comes from the client, because a shop has to be able to say
    who is a cashier. That makes this field the one place a posted string
    turns into a permission set - and the first thing somebody will try to
    post is "superadmin". It is an enum of the assignable roles, so the
    refusal happens here rather than relying on a check further in.
  */
  it("refuses superadmin as a role", () => {
    expect(staffSchema.safeParse({ ...base, role: "superadmin" }).success).toBe(
      false,
    );
  });

  it("refuses a role that does not exist", () => {
    expect(staffSchema.safeParse({ ...base, role: "owner" }).success).toBe(false);
    expect(staffSchema.safeParse({ ...base, role: "" }).success).toBe(false);
  });

  it("requires a role rather than defaulting to one", () => {
    // No silent default: an owner issuing a login chooses what it can do.
    const { role: _omitted, ...withoutRole } = base;
    expect(staffSchema.safeParse(withoutRole).success).toBe(false);
  });

  it("accepts every role a pharmacy can assign", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(staffSchema.safeParse({ ...base, role }).success, role).toBe(true);
    }
  });
});

describe("staffUpdateSchema branch handling", () => {
  /*
    Three states, not two - this is the bug the schema was rewritten to fix.
    Reusing the create schema's transform turned a missing branchId into null,
    so renaming somebody silently unassigned the outlet they work at.
  */
  it("leaves the branch alone when the field is not sent", () => {
    const parsed = staffUpdateSchema.parse({ name: "Sunita Karki" });
    expect(parsed.branchId).toBeUndefined();
    expect("branchId" in parsed && parsed.branchId !== undefined).toBe(false);
  });

  it("detaches the branch when the field is sent empty", () => {
    expect(staffUpdateSchema.parse({ branchId: "" }).branchId).toBeNull();
    expect(staffUpdateSchema.parse({ branchId: null }).branchId).toBeNull();
  });

  it("moves the branch when a real one is sent", () => {
    expect(staffUpdateSchema.parse({ branchId: BRANCH }).branchId).toBe(BRANCH);
  });

  it("accepts an update that changes nothing but the name", () => {
    const parsed = staffUpdateSchema.parse({ name: "Sunita K" });
    expect(parsed.name).toBe("Sunita K");
    expect(parsed.email).toBeUndefined();
  });

  it("rejects a branch id that is not one", () => {
    expect(staffUpdateSchema.safeParse({ branchId: "nope" }).success).toBe(false);
  });

  /*
    The role is optional on an update - absent means "leave it alone", the
    same three-state handling the branch needs - but when it is sent it goes
    through the same enum as the create form. An escalation attempt should not
    find a softer door on PATCH than on POST.
  */
  it("leaves the role alone when the field is not sent", () => {
    expect(staffUpdateSchema.parse({ name: "Sunita K" }).role).toBeUndefined();
  });

  it("changes the role when one is sent", () => {
    expect(staffUpdateSchema.parse({ role: "pharmacist" }).role).toBe("pharmacist");
  });

  it("refuses superadmin on an update too", () => {
    expect(staffUpdateSchema.safeParse({ role: "superadmin" }).success).toBe(false);
    expect(staffUpdateSchema.safeParse({ role: "wizard" }).success).toBe(false);
  });

  /*
    Passwords are changed through their own route. If this schema accepted one,
    a careless PATCH could reset a colleague's login as a side effect of a
    rename.
  */
  it("cannot change a password", () => {
    const parsed = staffUpdateSchema.parse({
      name: "Sunita Karki",
      password: "hunter2hunter2",
    }) as Record<string, unknown>;
    expect(parsed.password).toBeUndefined();
  });
});

describe("staffPasswordResetSchema", () => {
  it("holds the same floor as the create form", () => {
    expect(staffPasswordResetSchema.safeParse({ password: "short12" }).success).toBe(
      false,
    );
    expect(staffPasswordResetSchema.safeParse({ password: "exactly8" }).success).toBe(
      true,
    );
  });

  it("refuses a password bcrypt would silently truncate", () => {
    expect(
      staffPasswordResetSchema.safeParse({ password: "a".repeat(73) }).success,
    ).toBe(false);
    expect(
      staffPasswordResetSchema.safeParse({ password: "a".repeat(72) }).success,
    ).toBe(true);
  });
});

describe("staffActiveSchema", () => {
  it("reads the flag either way round", () => {
    expect(staffActiveSchema.parse({ isActive: true }).isActive).toBe(true);
    expect(staffActiveSchema.parse({ isActive: false }).isActive).toBe(false);
  });
});
