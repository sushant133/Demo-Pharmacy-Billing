import { describe, expect, it } from "vitest";
import { isSafeAppPath } from "@/lib/safe-path";

describe("isSafeAppPath", () => {
  it("accepts in-app paths", () => {
    expect(isSafeAppPath("/dashboard")).toBe(true);
    expect(isSafeAppPath("/sales?page=2#x")).toBe(true);
  });

  it("refuses anything that leaves the site", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "javascript:alert(1)",
      "evil.com",
      "",
      null,
    ]) {
      expect(isSafeAppPath(bad)).toBe(false);
    }
  });
});
