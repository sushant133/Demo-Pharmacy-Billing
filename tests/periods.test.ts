import { describe, expect, it } from "vitest";
import { nepaliPeriods } from "@/lib/periods";
import { adIsoToBsIso } from "@/lib/bs-date";

describe("nepaliPeriods", () => {
  it("starts the fiscal year on 1 Shrawan", () => {
    const periods = nepaliPeriods("2026-11-18");
    expect(periods).not.toBeNull();
    expect(periods!.fiscalYear.label).toBe("FY 2083-84");
    expect(adIsoToBsIso(periods!.fiscalYear.from)).toBe("2083-04-01");
    expect(adIsoToBsIso(periods!.lastFiscalYear.to)).toMatch(/^2083-03-/);
  });

  it("starts this month on its 1st", () => {
    const periods = nepaliPeriods("2026-11-18")!;
    expect(adIsoToBsIso(periods.thisMonth.from)?.endsWith("-01")).toBe(true);
    expect(periods.thisMonth.to).toBe("2026-11-18");
  });
});
