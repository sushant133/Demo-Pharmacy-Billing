import { describe, expect, it } from "vitest";
import { adToBs, formatBsIso, nepaliFiscalYear } from "@/lib/bs-date";

describe("adToBs", () => {
  it("converts the published anchor 1 Jan 1944 to 17 Poush 2000", () => {
    expect(adToBs(1944, 1, 1)).toEqual({ year: 2000, month: 9, day: 17 });
  });

  it("converts 1 Jan 2022 to 17 Poush 2078", () => {
    expect(formatBsIso(adToBs(2022, 1, 1))).toBe("2078-09-17");
  });

  it("converts Nepali New Year 2081 (13 Apr 2024) to 1 Baisakh", () => {
    expect(formatBsIso(adToBs(2024, 4, 13))).toBe("2081-01-01");
  });

  it("converts 28 Mar 2017 to 15 Chaitra 2073", () => {
    expect(formatBsIso(adToBs(2017, 3, 28))).toBe("2073-12-15");
  });
});

describe("nepaliFiscalYear", () => {
  it("starts on 1 Shrawan (month 4)", () => {
    expect(nepaliFiscalYear({ year: 2082, month: 4, day: 1 })).toBe("2082-83");
  });

  it("is still the previous FY through Ashadh (month 3)", () => {
    expect(nepaliFiscalYear({ year: 2083, month: 3, day: 31 })).toBe("2082-83");
  });
});
