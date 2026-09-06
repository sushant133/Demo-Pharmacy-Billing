import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  BACKUP_FORMAT,
  backupFilename,
  serializeValue,
} from "@/lib/pharmacy-backup";

describe("backupFilename", () => {
  it("uses the pharmacy slug and the UTC date", () => {
    expect(backupFilename("sagarmatha-pharmacy", new Date("2026-09-05T18:00:00Z"))).toBe(
      "sagarmatha-pharmacy-2026-09-05.json",
    );
  });

  it("slugifies a trading name so the file is safe to download", () => {
    expect(backupFilename("Sagarmatha Pharmacy", new Date("2026-01-02T00:00:00Z"))).toBe(
      "sagarmatha-pharmacy-2026-01-02.json",
    );
  });
});

describe("serializeValue", () => {
  it("turns ObjectIds and dates into JSON primitives", () => {
    const id = new Types.ObjectId("64b0f0c2a1b2c3d4e5f60789");
    const out = serializeValue({
      _id: id,
      createdAt: new Date("2026-09-05T00:00:00.000Z"),
      nested: { pharmacyId: id },
    }) as Record<string, unknown>;

    expect(out._id).toBe("64b0f0c2a1b2c3d4e5f60789");
    expect(out.createdAt).toBe("2026-09-05T00:00:00.000Z");
    expect((out.nested as { pharmacyId: string }).pharmacyId).toBe(
      "64b0f0c2a1b2c3d4e5f60789",
    );
  });

  it("never writes a password hash into the dump", () => {
    const out = serializeValue({
      email: "owner@sagarmatha.local",
      passwordHash: "$2a$12$secret",
      __v: 0,
    }) as Record<string, unknown>;

    expect(out.email).toBe("owner@sagarmatha.local");
    expect(out.passwordHash).toBeUndefined();
    expect(out.__v).toBeUndefined();
  });
});

describe("BACKUP_FORMAT", () => {
  it("is a stable tag so a restore can refuse a foreign file", () => {
    expect(BACKUP_FORMAT).toBe("mantrapharma-pharmacy-backup");
  });
});
