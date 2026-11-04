import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { diffRecords, signAuditEntry, verifyAuditEntry } from "@/lib/audit";

describe("diffRecords", () => {
  it("lists only the fields that changed, with old and new values", () => {
    const changes = diffRecords(
      { name: "Cetzine", reorderLevel: 10, unit: "tablet" },
      { name: "Cetzine", reorderLevel: 25, unit: "tablet" },
    );
    expect(changes).toEqual([{ path: "reorderLevel", before: 10, after: 25 }]);
  });

  it("ignores updatedAt and the version key", () => {
    const changes = diffRecords(
      { name: "A", updatedAt: new Date("2026-01-01"), __v: 1 },
      { name: "A", updatedAt: new Date("2026-02-01"), __v: 2 },
    );
    expect(changes).toEqual([]);
  });

  it("records a creation as every field going from nothing to its value", () => {
    const changes = diffRecords(null, { name: "A", qty: 3 });
    expect(changes).toEqual([
      { path: "name", before: null, after: "A" },
      { path: "qty", before: null, after: 3 },
    ]);
  });

  it("never copies a password hash into the log", () => {
    const changes = diffRecords({ passwordHash: "old" }, { passwordHash: "new" });
    expect(changes).toEqual([
      { path: "passwordHash", before: "[redacted]", after: "[redacted]" },
    ]);
  });

  it("compares ObjectIds and dates by value", () => {
    const id = new Types.ObjectId();
    expect(
      diffRecords(
        { branchId: id, at: new Date("2026-01-01T00:00:00Z") },
        { branchId: new Types.ObjectId(String(id)), at: new Date("2026-01-01T00:00:00Z") },
      ),
    ).toEqual([]);
  });
});

describe("audit signatures", () => {
  const entry = {
    pharmacyId: new Types.ObjectId(),
    at: new Date("2026-10-01T10:00:00Z"),
    action: "update",
    entity: "Sale",
    entityId: "abc",
    label: "INV-2083-84-000001",
    changes: [{ path: "reprintCount", before: 0, after: 1 }],
    actorId: "u1",
    actorName: "Sunita",
    actorRole: "cashier",
    impersonatorName: "",
    method: "POST",
    path: "/api/sales/abc/print",
    ip: "",
    userAgent: "",
    note: "",
  };

  it("verifies an entry exactly as written", () => {
    const signature = signAuditEntry(entry);
    expect(verifyAuditEntry({ ...entry, signature })).toBe(true);
  });

  it("fails an entry whose values were edited afterwards", () => {
    const signature = signAuditEntry(entry);
    expect(
      verifyAuditEntry({
        ...entry,
        changes: [{ path: "reprintCount", before: 0, after: 0 }],
        signature,
      }),
    ).toBe(false);
    expect(verifyAuditEntry({ ...entry, actorName: "Someone else", signature })).toBe(false);
  });

  it("still verifies after a database round trip turns ids into strings", () => {
    const signature = signAuditEntry(entry);
    const stored = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    expect(verifyAuditEntry({ ...stored, signature })).toBe(true);
  });
});
