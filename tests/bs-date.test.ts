import { describe, expect, it } from "vitest";
import {
  adIsoToBsIso,
  adToBs,
  bsIsoToAdIso,
  bsToAd,
  formatBsIso,
  nepaliFiscalYear,
} from "@/lib/bs-date";

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

describe("bsToAd", () => {
  it("is the inverse of the published anchor", () => {
    expect(bsToAd(2000, 9, 17)).toEqual({ year: 1944, month: 1, day: 1 });
  });

  it("round-trips New Year 2081", () => {
    expect(bsToAd(2081, 1, 1)).toEqual({ year: 2024, month: 4, day: 13 });
  });

  it("round-trips ISO strings both ways", () => {
    expect(adIsoToBsIso("2024-04-13")).toBe("2081-01-01");
    expect(bsIsoToAdIso("2081-01-01")).toBe("2024-04-13");
    const bs = adIsoToBsIso("2025-09-05");
    expect(bs).toMatch(/^2082-/);
    expect(bsIsoToAdIso(bs!)).toBe("2025-09-05");
  });

  it("round-trips every day of 2024 and 2025", () => {
    for (const year of [2024, 2025]) {
      for (let month = 1; month <= 12; month++) {
        const last = month === 2 ? (year % 4 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
        for (let day = 1; day <= last; day++) {
          const bs = adToBs(year, month, day);
          const ad = bsToAd(bs.year, bs.month, bs.day);
          expect(ad, `${year}-${month}-${day}`).toEqual({ year, month, day });
        }
      }
    }
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
