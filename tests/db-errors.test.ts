import { describe, expect, it } from "vitest";
import { isTransientDbError } from "@/lib/db";
import { dateInputValue } from "@/lib/dates";

describe("isTransientDbError", () => {
  it("treats dead-pool names as retryable", () => {
    for (const name of [
      "MongoNetworkError",
      "MongoNotConnectedError",
      "MongoServerSelectionError",
      "MongoPoolClearedError",
      "MongoTopologyClosedError",
    ]) {
      expect(isTransientDbError({ name })).toBe(true);
    }
  });

  it("treats buffering timeouts as retryable", () => {
    expect(
      isTransientDbError({
        name: "MongooseError",
        message: "Operation `medicines.find()` buffering timed out after 10000ms",
      }),
    ).toBe(true);
  });

  it("does not retry auth or validation failures", () => {
    expect(isTransientDbError({ name: "MongoServerError", message: "bad auth" })).toBe(
      false,
    );
    expect(isTransientDbError({ name: "ValidationError", message: "Path `name` is required" })).toBe(
      false,
    );
  });
});

describe("dateInputValue", () => {
  it("returns empty for missing or invalid values instead of throwing", () => {
    expect(dateInputValue(null)).toBe("");
    expect(dateInputValue(undefined)).toBe("");
    expect(dateInputValue("")).toBe("");
    expect(dateInputValue("not-a-date")).toBe("");
    expect(dateInputValue(new Date("invalid"))).toBe("");
  });

  it("formats a real date as YYYY-MM-DD", () => {
    expect(dateInputValue("2026-12-01")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
