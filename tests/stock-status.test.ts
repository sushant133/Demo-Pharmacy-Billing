import { describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import {
  daysToExpiry,
  isLowStock,
  isStockFilter,
  matchesStockFilter,
  stockStatus,
  type StockLevel,
} from "@/lib/stock-status";

const NOW = new Date("2026-06-15T10:00:00.000Z");

/** Days from NOW, as an expiry date. */
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

function level(overrides: Partial<StockLevel> = {}): StockLevel {
  return {
    sellable: 200,
    expiredUnits: 0,
    reorderLevel: 20,
    nearestExpiry: inDays(365),
    ...overrides,
  };
}

describe("isLowStock", () => {
  it("counts sellable units only, not expired boxes on the same shelf", () => {
    // 5 sellable against a reorder level of 20 is low, whatever else is there.
    expect(isLowStock(level({ sellable: 5, expiredUnits: 400 }))).toBe(true);
  });

  it("treats at-the-level as low, not merely below it", () => {
    expect(isLowStock(level({ sellable: 20, reorderLevel: 20 }))).toBe(true);
    expect(isLowStock(level({ sellable: 21, reorderLevel: 20 }))).toBe(false);
  });

  it("is never low when the medicine has no reorder level set", () => {
    expect(isLowStock(level({ sellable: 1, reorderLevel: null }))).toBe(false);
    expect(isLowStock(level({ sellable: 0, reorderLevel: null }))).toBe(false);
  });
});

describe("daysToExpiry", () => {
  it("counts whole days to the earliest sellable lot", () => {
    expect(daysToExpiry(level({ nearestExpiry: inDays(45) }), NOW)).toBe(45);
    expect(daysToExpiry(level({ nearestExpiry: inDays(0) }), NOW)).toBe(0);
  });

  it("is null when nothing sellable is left to have a date", () => {
    expect(daysToExpiry(level({ nearestExpiry: null }), NOW)).toBeNull();
  });

  it("does not throw on a date it cannot read", () => {
    expect(daysToExpiry(level({ nearestExpiry: "not a date" }), NOW)).toBeNull();
  });
});

describe("stockStatus precedence", () => {
  it("calls a line with nothing sellable expired, whatever else is true of it", () => {
    const row = level({ sellable: 0, expiredUnits: 60, nearestExpiry: null });
    expect(stockStatus(row, NOW).status).toBe("expired");
  });

  it("puts low ahead of expiring, because reordering comes first", () => {
    const row = level({ sellable: 4, nearestExpiry: inDays(10) });
    expect(stockStatus(row, NOW).status).toBe("low");
  });

  it("flags stock inside the expiry alert window", () => {
    const row = level({ nearestExpiry: inDays(config.expiryAlertDays - 1) });
    expect(stockStatus(row, NOW).status).toBe("expiring");
  });

  it("treats the alert window as inclusive, and the day after as fine", () => {
    expect(
      stockStatus(level({ nearestExpiry: inDays(config.expiryAlertDays) }), NOW)
        .status,
    ).toBe("expiring");
    expect(
      stockStatus(
        level({ nearestExpiry: inDays(config.expiryAlertDays + 1) }),
        NOW,
      ).status,
    ).toBe("ok");
  });

  it("is plain in stock when there is enough of it and time on it", () => {
    const view = stockStatus(level(), NOW);
    expect(view.status).toBe("ok");
    expect(view.label).toBe("In stock");
    expect(view.tone).toBe("green");
  });

  it("does not call a healthy line expired just for holding some dead boxes", () => {
    const row = level({ sellable: 300, expiredUnits: 12 });
    expect(stockStatus(row, NOW).status).toBe("ok");
  });
});

describe("matchesStockFilter", () => {
  it("finds exactly the rows the badges show", () => {
    const rows = [
      level({ sellable: 4 }), // low
      level({ nearestExpiry: inDays(10) }), // expiring
      level({ sellable: 0, expiredUnits: 9, nearestExpiry: null }), // expired
      level(), // ok
    ];

    for (const row of rows) {
      const badge = stockStatus(row, NOW).status;
      expect(matchesStockFilter(row, badge, NOW)).toBe(true);
    }
  });

  it("passes everything through the all filter", () => {
    expect(matchesStockFilter(level({ sellable: 0 }), "all", NOW)).toBe(true);
  });

  /*
    The one deliberate departure from "the filter matches the badge": a line
    that still reads In stock but has dead boxes on it is exactly what somebody
    hunting for stock to write off needs to find.
  */
  it("finds any line holding expired stock, not only lines that are all expired", () => {
    const healthyWithDeadBoxes = level({ sellable: 300, expiredUnits: 12 });
    expect(stockStatus(healthyWithDeadBoxes, NOW).status).toBe("ok");
    expect(matchesStockFilter(healthyWithDeadBoxes, "expired", NOW)).toBe(true);

    expect(matchesStockFilter(level(), "expired", NOW)).toBe(false);
  });
});

describe("isStockFilter", () => {
  it("accepts the filters the dropdown offers and nothing else", () => {
    expect(isStockFilter("all")).toBe(true);
    expect(isStockFilter("expiring")).toBe(true);
    expect(isStockFilter("nonsense")).toBe(false);
    expect(isStockFilter(undefined)).toBe(false);
  });
});
