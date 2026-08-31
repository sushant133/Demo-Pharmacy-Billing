import { describe, expect, it } from "vitest";
import {
  AlertRuleError,
  DEFAULT_EXPIRY_THRESHOLDS,
  assessStock,
  averageDailySales,
  daysOfCover,
  expiryRank,
  expirySeverity,
  isDeadStock,
  stockRank,
  valueAtRisk,
} from "@/lib/alert-rules";

/**
 * These rules decide what a pharmacist is told to act on each morning. A
 * threshold that is one day out, or a days-of-cover that silently divides by
 * zero, quietly changes what gets ordered - so every boundary is pinned here.
 */

describe("expirySeverity", () => {
  it("grades a past expiry as expired", () => {
    expect(expirySeverity(-1)).toBe("expired");
    expect(expirySeverity(-500)).toBe("expired");
  });

  it("treats the expiry day itself as still in date, not expired", () => {
    // Consistent with FEFO: a lot is sellable through its expiry date.
    expect(expirySeverity(0)).toBe("critical");
  });

  it("puts a boundary day in the harsher band", () => {
    expect(expirySeverity(30)).toBe("critical");
    expect(expirySeverity(31)).toBe("warning");
    expect(expirySeverity(60)).toBe("warning");
    expect(expirySeverity(61)).toBe("watch");
    expect(expirySeverity(90)).toBe("watch");
    expect(expirySeverity(91)).toBe("ok");
  });

  it("accepts custom thresholds", () => {
    const tight = { critical: 7, warning: 14, watch: 21 };
    expect(expirySeverity(7, tight)).toBe("critical");
    expect(expirySeverity(20, tight)).toBe("watch");
    expect(expirySeverity(22, tight)).toBe("ok");
  });

  it("ranks worst first for sorting", () => {
    expect(expiryRank("expired")).toBeLessThan(expiryRank("critical"));
    expect(expiryRank("critical")).toBeLessThan(expiryRank("ok"));
  });

  it("uses the documented default thresholds", () => {
    expect(DEFAULT_EXPIRY_THRESHOLDS).toEqual({
      critical: 30,
      warning: 60,
      watch: 90,
    });
  });
});

describe("daysOfCover", () => {
  it("divides stock by the daily rate", () => {
    expect(daysOfCover(100, 5)).toBe(20);
  });

  it("floors to one decimal rather than overstating cover", () => {
    // 100 / 3 = 33.33... -> 33.3, never rounded up to 33.4.
    expect(daysOfCover(100, 3)).toBe(33.3);
  });

  it("returns null with no sales history instead of Infinity", () => {
    expect(daysOfCover(100, 0)).toBeNull();
  });

  it("returns zero cover for empty stock that does sell", () => {
    expect(daysOfCover(0, 5)).toBe(0);
  });

  it("rejects negative stock", () => {
    expect(() => daysOfCover(-1, 5)).toThrow(AlertRuleError);
  });
});

describe("averageDailySales", () => {
  it("averages units over the window", () => {
    expect(averageDailySales(90, 30)).toBe(3);
  });

  it("keeps precision on slow movers", () => {
    expect(averageDailySales(1, 30)).toBe(0.0333);
  });

  it("is zero when nothing sold", () => {
    expect(averageDailySales(0, 30)).toBe(0);
  });

  it("rejects a zero-length window", () => {
    expect(() => averageDailySales(10, 0)).toThrow(AlertRuleError);
  });
});

describe("assessStock - with sales history", () => {
  const base = { reorderLevel: 20, targetCoverDays: 45, leadTimeDays: 7 };

  it("flags stock that runs out before a restock could arrive", () => {
    // 30 units at 5/day = 6 days cover, inside the 7-day lead time.
    const result = assessStock({ ...base, stockQuantity: 30, averageDailySales: 5 });
    expect(result.severity).toBe("critical");
    expect(result.basis).toBe("days-of-cover");
    expect(result.daysOfCover).toBe(6);
  });

  it("flags stock below target cover as low", () => {
    // 100 at 5/day = 20 days: past lead time, short of the 45-day target.
    const result = assessStock({ ...base, stockQuantity: 100, averageDailySales: 5 });
    expect(result.severity).toBe("low");
  });

  it("calls healthy stock healthy and suggests no order", () => {
    const result = assessStock({ ...base, stockQuantity: 250, averageDailySales: 5 });
    expect(result.severity).toBe("ok");
    expect(result.suggestedOrderQuantity).toBe(0);
  });

  it("flags far more than target cover as overstocked", () => {
    // 1000 at 5/day = 200 days, past 3x the 45-day target.
    const result = assessStock({ ...base, stockQuantity: 1000, averageDailySales: 5 });
    expect(result.severity).toBe("overstocked");
    expect(result.suggestedOrderQuantity).toBe(0);
  });

  it("suggests enough to reach target cover plus the lead time", () => {
    // Target = 5 * (45 + 7) = 260. Holding 100 -> order 160.
    const result = assessStock({ ...base, stockQuantity: 100, averageDailySales: 5 });
    expect(result.suggestedOrderQuantity).toBe(160);
  });

  it("distinguishes a fast mover from a slow one at the same unit count", () => {
    const fast = assessStock({ ...base, stockQuantity: 20, averageDailySales: 10 });
    const slow = assessStock({ ...base, stockQuantity: 20, averageDailySales: 0.1 });

    // This is the whole point of days-of-cover over a flat threshold.
    expect(fast.severity).toBe("critical");
    expect(slow.severity).toBe("overstocked");
  });
});

describe("assessStock - without sales history", () => {
  const base = { reorderLevel: 20, averageDailySales: 0 };

  it("falls back to the flat reorder level and says so", () => {
    const result = assessStock({ ...base, stockQuantity: 15 });
    expect(result.basis).toBe("reorder-level");
    expect(result.severity).toBe("low");
    expect(result.daysOfCover).toBeNull();
  });

  it("treats less than half the reorder level as critical", () => {
    expect(assessStock({ ...base, stockQuantity: 9 }).severity).toBe("critical");
  });

  it("is healthy at or above the reorder level", () => {
    expect(assessStock({ ...base, stockQuantity: 20 }).severity).toBe("ok");
    expect(assessStock({ ...base, stockQuantity: 500 }).severity).toBe("ok");
  });

  it("never reports overstocked without a rate to judge it by", () => {
    // 500 units of something that has never sold could be right or wrong; the
    // rule refuses to guess rather than raising a false alarm.
    expect(assessStock({ ...base, stockQuantity: 500 }).severity).not.toBe(
      "overstocked",
    );
  });

  it("suggests topping up to the reorder level", () => {
    expect(assessStock({ ...base, stockQuantity: 5 }).suggestedOrderQuantity).toBe(15);
  });
});

describe("assessStock - empty shelf", () => {
  it("is always 'out' regardless of rate", () => {
    expect(
      assessStock({ stockQuantity: 0, averageDailySales: 5, reorderLevel: 20 }).severity,
    ).toBe("out");
    expect(
      assessStock({ stockQuantity: 0, averageDailySales: 0, reorderLevel: 20 }).severity,
    ).toBe("out");
  });

  it("orders target plus lead time when the rate is known", () => {
    const result = assessStock({
      stockQuantity: 0,
      averageDailySales: 5,
      reorderLevel: 20,
      targetCoverDays: 45,
      leadTimeDays: 7,
    });
    expect(result.suggestedOrderQuantity).toBe(260);
  });

  it("falls back to the reorder level when the rate is unknown", () => {
    const result = assessStock({
      stockQuantity: 0,
      averageDailySales: 0,
      reorderLevel: 20,
    });
    expect(result.suggestedOrderQuantity).toBe(20);
    expect(result.basis).toBe("reorder-level");
  });

  it("rejects negative stock and a zero cover target", () => {
    expect(() =>
      assessStock({ stockQuantity: -1, averageDailySales: 1, reorderLevel: 5 }),
    ).toThrow(AlertRuleError);
    expect(() =>
      assessStock({
        stockQuantity: 1,
        averageDailySales: 1,
        reorderLevel: 5,
        targetCoverDays: 0,
      }),
    ).toThrow(AlertRuleError);
  });

  it("ranks worst first for sorting", () => {
    expect(stockRank("out")).toBeLessThan(stockRank("low"));
    expect(stockRank("low")).toBeLessThan(stockRank("ok"));
  });
});

describe("isDeadStock", () => {
  it("does not condemn stock that has not had a fair chance", () => {
    // Received 10 days ago, never sold - too early to call.
    expect(
      isDeadStock({ daysSinceLastSale: null, daysSinceReceived: 10 }),
    ).toBe(false);
  });

  it("flags stock that has sat unsold past the threshold", () => {
    expect(
      isDeadStock({ daysSinceLastSale: null, daysSinceReceived: 120 }),
    ).toBe(true);
  });

  it("flags stock whose last sale is older than the threshold", () => {
    expect(
      isDeadStock({ daysSinceLastSale: 100, daysSinceReceived: 400 }),
    ).toBe(true);
  });

  it("clears stock that sold recently", () => {
    expect(
      isDeadStock({ daysSinceLastSale: 3, daysSinceReceived: 400 }),
    ).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(
      isDeadStock({
        daysSinceLastSale: 40,
        daysSinceReceived: 400,
        thresholdDays: 30,
      }),
    ).toBe(true);
  });
});

describe("valueAtRisk", () => {
  it("counts nothing at risk when the stock will sell in time", () => {
    // 100 units, 60 days left, selling 5/day = 300 units of demand.
    expect(
      valueAtRisk([{ quantity: 100, costPrice: 10, daysRemaining: 60 }], 5),
    ).toBe(0);
  });

  it("counts only the surplus that cannot sell before expiry", () => {
    // 100 units, 10 days left, 5/day sells 50 -> 50 stranded at 10 = 500.
    expect(
      valueAtRisk([{ quantity: 100, costPrice: 10, daysRemaining: 10 }], 5),
    ).toBe(500);
  });

  it("counts the whole lot when nothing is selling", () => {
    expect(
      valueAtRisk([{ quantity: 100, costPrice: 10, daysRemaining: 60 }], 0),
    ).toBe(1000);
  });

  it("counts an already-expired lot in full", () => {
    expect(
      valueAtRisk([{ quantity: 20, costPrice: 5, daysRemaining: -3 }], 5),
    ).toBe(100);
  });

  it("sums across lots", () => {
    expect(
      valueAtRisk(
        [
          { quantity: 100, costPrice: 10, daysRemaining: 0 },
          { quantity: 50, costPrice: 4, daysRemaining: 0 },
        ],
        0,
      ),
    ).toBe(1200);
  });

  it("is zero for no lots", () => {
    expect(valueAtRisk([], 5)).toBe(0);
  });
});
