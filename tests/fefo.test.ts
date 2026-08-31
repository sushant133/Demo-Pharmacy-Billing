import { describe, expect, it } from "vitest";
import {
  FefoError,
  allocateFefo,
  calculateTotals,
  compareFefo,
  describeShortfall,
  flattenPicks,
  isExpired,
  mergeRequests,
  round2,
  sellableBatches,
  type AllocatableBatch,
} from "@/lib/fefo";

/**
 * FEFO is the piece of business logic that, if wrong, either poisons a
 * customer with expired stock or silently loses the shop money. It is a pure
 * function precisely so it can be pinned down here.
 *
 * `NOW` is fixed so these tests never depend on the wall clock.
 */

const NOW = new Date("2026-06-15T10:00:00.000Z");

const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

let batchCounter = 0;

function batch(overrides: Partial<AllocatableBatch> = {}): AllocatableBatch {
  batchCounter += 1;
  return {
    batchId: `batch-${batchCounter}`,
    medicineId: "med-A",
    batchNumber: `B${batchCounter}`,
    quantity: 100,
    salePrice: 10,
    expiryDate: days(365),
    createdAt: NOW,
    ...overrides,
  };
}

describe("round2", () => {
  it("avoids binary floating point drift", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });

  it("leaves whole numbers alone", () => {
    expect(round2(10)).toBe(10);
    expect(round2(0)).toBe(0);
  });
});

describe("isExpired", () => {
  it("treats a batch expiring in the future as usable", () => {
    expect(isExpired({ expiryDate: days(1) }, NOW)).toBe(false);
  });

  it("treats a batch expiring exactly now as still usable", () => {
    // Expiry is the last usable instant, so equality is not yet expired.
    expect(isExpired({ expiryDate: NOW }, NOW)).toBe(false);
  });

  it("treats a past expiry as expired", () => {
    expect(isExpired({ expiryDate: days(-1) }, NOW)).toBe(true);
  });
});

describe("compareFefo / sellableBatches", () => {
  it("orders by earliest expiry first", () => {
    const late = batch({ expiryDate: days(200) });
    const early = batch({ expiryDate: days(10) });
    const middle = batch({ expiryDate: days(100) });

    const sorted = sellableBatches([late, early, middle], NOW);
    expect(sorted.map((item) => item.batchId)).toEqual([
      early.batchId,
      middle.batchId,
      late.batchId,
    ]);
  });

  it("breaks an expiry tie with the older batch", () => {
    const newer = batch({ expiryDate: days(30), createdAt: days(-1) });
    const older = batch({ expiryDate: days(30), createdAt: days(-90) });

    expect(compareFefo(older, newer)).toBeLessThan(0);
    expect(sellableBatches([newer, older], NOW)[0]?.batchId).toBe(older.batchId);
  });

  it("falls back to batch id so ordering is fully deterministic", () => {
    const a = batch({ batchId: "aaa", expiryDate: days(30), createdAt: NOW });
    const b = batch({ batchId: "bbb", expiryDate: days(30), createdAt: NOW });

    expect(compareFefo(a, b)).toBeLessThan(0);
    expect(compareFefo(b, a)).toBeGreaterThan(0);
  });

  it("excludes expired and zero-quantity batches", () => {
    const good = batch({ expiryDate: days(30) });
    const expired = batch({ expiryDate: days(-1) });
    const empty = batch({ quantity: 0 });

    const sellable = sellableBatches([good, expired, empty], NOW);
    expect(sellable.map((item) => item.batchId)).toEqual([good.batchId]);
  });

  it("does not mutate the input array order", () => {
    const first = batch({ expiryDate: days(300) });
    const second = batch({ expiryDate: days(10) });
    const input = [first, second];

    sellableBatches(input, NOW);
    expect(input[0]).toBe(first);
  });
});

describe("mergeRequests", () => {
  it("merges duplicate lines for the same medicine", () => {
    expect(
      mergeRequests([
        { medicineId: "A", quantity: 2 },
        { medicineId: "B", quantity: 1 },
        { medicineId: "A", quantity: 3 },
      ]),
    ).toEqual([
      { medicineId: "A", quantity: 5 },
      { medicineId: "B", quantity: 1 },
    ]);
  });

  it("rejects an empty cart", () => {
    expect(() => mergeRequests([])).toThrow(FefoError);
  });

  it("rejects zero, negative and fractional quantities", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(() => mergeRequests([{ medicineId: "A", quantity }])).toThrow(FefoError);
    }
  });
});

describe("allocateFefo - happy path", () => {
  it("fills a line from a single batch", () => {
    const only = batch({ quantity: 50, salePrice: 12, expiryDate: days(120) });
    const result = allocateFefo([{ medicineId: "med-A", quantity: 10 }], [only], NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = result.lines[0]!;
    expect(line.picks).toHaveLength(1);
    expect(line.picks[0]).toMatchObject({
      batchId: only.batchId,
      quantity: 10,
      unitPrice: 12,
      subtotal: 120,
    });
    expect(line.lineTotal).toBe(120);
  });

  it("dispenses the earliest-expiring batch before a later one", () => {
    const later = batch({ batchNumber: "LATE", quantity: 100, expiryDate: days(300) });
    const sooner = batch({ batchNumber: "SOON", quantity: 100, expiryDate: days(20) });

    const result = allocateFefo(
      [{ medicineId: "med-A", quantity: 30 }],
      [later, sooner],
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]!.picks.map((pick) => pick.batchNumber)).toEqual(["SOON"]);
  });

  it("splits a line across batches when one is not enough", () => {
    const first = batch({ batchNumber: "B1", quantity: 8, salePrice: 10, expiryDate: days(10) });
    const second = batch({ batchNumber: "B2", quantity: 20, salePrice: 12, expiryDate: days(60) });

    const result = allocateFefo(
      [{ medicineId: "med-A", quantity: 15 }],
      [first, second],
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = result.lines[0]!;
    expect(line.picks).toHaveLength(2);
    // Earliest expiry is drained first, remainder comes from the next lot.
    expect(line.picks[0]).toMatchObject({ batchNumber: "B1", quantity: 8, subtotal: 80 });
    expect(line.picks[1]).toMatchObject({ batchNumber: "B2", quantity: 7, subtotal: 84 });
    expect(line.lineTotal).toBe(164);
  });

  it("splits across three batches when needed", () => {
    const batches = [
      batch({ batchNumber: "B1", quantity: 5, salePrice: 10, expiryDate: days(10) }),
      batch({ batchNumber: "B2", quantity: 5, salePrice: 10, expiryDate: days(20) }),
      batch({ batchNumber: "B3", quantity: 5, salePrice: 10, expiryDate: days(30) }),
    ];

    const result = allocateFefo([{ medicineId: "med-A", quantity: 13 }], batches, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines[0]!.picks.map((pick) => [pick.batchNumber, pick.quantity])).toEqual(
      [
        ["B1", 5],
        ["B2", 5],
        ["B3", 3],
      ],
    );
  });

  it("prices each split at that batch's own sale price", () => {
    const cheap = batch({ quantity: 3, salePrice: 5, expiryDate: days(10) });
    const dear = batch({ quantity: 10, salePrice: 20, expiryDate: days(90) });

    const result = allocateFefo([{ medicineId: "med-A", quantity: 5 }], [cheap, dear], NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 × 5 + 2 × 20 = 55, not 5 × one blended price.
    expect(result.lines[0]!.lineTotal).toBe(55);
  });

  it("keeps medicines independent of each other", () => {
    const batches = [
      batch({ medicineId: "med-A", quantity: 10, salePrice: 10, expiryDate: days(30) }),
      batch({ medicineId: "med-B", quantity: 10, salePrice: 20, expiryDate: days(5) }),
    ];

    const result = allocateFefo(
      [
        { medicineId: "med-A", quantity: 2 },
        { medicineId: "med-B", quantity: 3 },
      ],
      batches,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.lineTotal).toBe(20);
    expect(result.lines[1]!.lineTotal).toBe(60);
  });
});

describe("allocateFefo - expiry safety", () => {
  it("never dispenses an expired batch even when it is the only stock", () => {
    const expired = batch({ quantity: 500, expiryDate: days(-1) });
    const result = allocateFefo([{ medicineId: "med-A", quantity: 1 }], [expired], NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls[0]).toMatchObject({
      reason: "all-stock-expired",
      available: 0,
      expiredUnitsIgnored: 500,
    });
  });

  it("skips an expired batch and uses the next unexpired one", () => {
    const expired = batch({ batchNumber: "OLD", quantity: 100, expiryDate: days(-5) });
    const usable = batch({ batchNumber: "NEW", quantity: 100, expiryDate: days(200) });

    const result = allocateFefo(
      [{ medicineId: "med-A", quantity: 10 }],
      [expired, usable],
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]!.picks.map((pick) => pick.batchNumber)).toEqual(["NEW"]);
  });

  it("still dispenses a batch expiring later today", () => {
    const today = batch({ quantity: 10, expiryDate: new Date(NOW.getTime() + 3_600_000) });
    const result = allocateFefo([{ medicineId: "med-A", quantity: 5 }], [today], NOW);
    expect(result.ok).toBe(true);
  });

  it("does not count expired stock towards availability", () => {
    const expired = batch({ quantity: 90, expiryDate: days(-1) });
    const good = batch({ quantity: 10, expiryDate: days(30) });

    const result = allocateFefo([{ medicineId: "med-A", quantity: 20 }], [expired, good], NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls[0]).toMatchObject({
      reason: "insufficient-stock",
      available: 10,
      shortBy: 10,
      expiredUnitsIgnored: 90,
    });
  });
});

describe("allocateFefo - shortfalls", () => {
  it("rejects the whole line rather than partially filling it", () => {
    const only = batch({ quantity: 5 });
    const result = allocateFefo([{ medicineId: "med-A", quantity: 10 }], [only], NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls[0]).toMatchObject({
      requested: 10,
      available: 5,
      shortBy: 5,
      reason: "insufficient-stock",
    });
  });

  it("reports a medicine with no batches at all as out of stock", () => {
    const result = allocateFefo([{ medicineId: "med-ZZZ", quantity: 1 }], [], NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls[0]).toMatchObject({
      medicineId: "med-ZZZ",
      reason: "out-of-stock",
      available: 0,
    });
  });

  it("returns every shortfall at once, not just the first", () => {
    const result = allocateFefo(
      [
        { medicineId: "med-A", quantity: 5 },
        { medicineId: "med-B", quantity: 5 },
      ],
      [],
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls).toHaveLength(2);
  });

  it("counts merged duplicate lines against one pool", () => {
    // 6 + 6 = 12 requested against only 10 available.
    const only = batch({ quantity: 10 });
    const result = allocateFefo(
      [
        { medicineId: "med-A", quantity: 6 },
        { medicineId: "med-A", quantity: 6 },
      ],
      [only],
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls[0]).toMatchObject({ requested: 12, available: 10 });
  });
});

describe("allocateFefo - purity", () => {
  it("does not mutate the caller's batch quantities", () => {
    const source = batch({ quantity: 100 });
    const before = source.quantity;

    const result = allocateFefo([{ medicineId: "med-A", quantity: 40 }], [source], NOW);

    expect(result.ok).toBe(true);
    // The caller still sees real stock; only the DB write may change it.
    expect(source.quantity).toBe(before);
  });

  it("is deterministic across repeated runs", () => {
    const batches = [
      batch({ batchNumber: "B1", quantity: 7, expiryDate: days(10) }),
      batch({ batchNumber: "B2", quantity: 7, expiryDate: days(10) }),
    ];
    const request = [{ medicineId: "med-A", quantity: 10 }];

    const first = allocateFefo(request, batches, NOW);
    const second = allocateFefo(request, batches, NOW);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("flattenPicks", () => {
  it("flattens split lines into one entry per batch draw", () => {
    const result = allocateFefo(
      [{ medicineId: "med-A", quantity: 15 }],
      [
        batch({ quantity: 8, expiryDate: days(10) }),
        batch({ quantity: 20, expiryDate: days(60) }),
      ],
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const flat = flattenPicks(result.lines);
    expect(flat).toHaveLength(2);
    expect(flat.every((entry) => entry.medicineId === "med-A")).toBe(true);
  });
});

describe("calculateTotals", () => {
  it("applies 13% VAT on the full subtotal when there is no discount", () => {
    expect(calculateTotals({ grossSubtotal: 1000, vatRate: 0.13 })).toEqual({
      subtotal: 1000,
      discount: 0,
      discountPercent: 0,
      taxableAmount: 1000,
      vatAmount: 130,
      totalAmount: 1130,
    });
  });

  it("charges VAT on the discounted amount, not the gross", () => {
    // Nepal convention: discount first, then VAT on what is actually payable.
    expect(calculateTotals({ grossSubtotal: 1000, discount: 100, vatRate: 0.13 })).toEqual({
      subtotal: 1000,
      discount: 100,
      discountPercent: 0,
      taxableAmount: 900,
      vatAmount: 117,
      totalAmount: 1017,
    });
  });

  it("supports a zero VAT rate", () => {
    const totals = calculateTotals({ grossSubtotal: 500, vatRate: 0 });
    expect(totals.vatAmount).toBe(0);
    expect(totals.totalAmount).toBe(500);
  });

  it("allows a discount equal to the whole subtotal", () => {
    const totals = calculateTotals({ grossSubtotal: 250, discount: 250, vatRate: 0.13 });
    expect(totals.taxableAmount).toBe(0);
    expect(totals.totalAmount).toBe(0);
  });

  it("turns a percentage into the rupee figure the bill shows", () => {
    const totals = calculateTotals({
      grossSubtotal: 1000,
      discountPercent: 10,
      vatRate: 0.13,
    });
    expect(totals.discount).toBe(100);
    expect(totals.discountPercent).toBe(10);
    expect(totals.taxableAmount).toBe(900);
    expect(totals.vatAmount).toBe(117);
    expect(totals.totalAmount).toBe(1017);
  });

  it("rounds the percentage to paisa, not to a fraction of one", () => {
    // 7.5% of 333.33 is 24.99975, which has to become a payable amount.
    const totals = calculateTotals({
      grossSubtotal: 333.33,
      discountPercent: 7.5,
      vatRate: 0.13,
    });
    expect(totals.discount).toBe(25);
    expect(totals.taxableAmount).toBe(308.33);
  });

  it("lets a percentage win over a rupee amount sent alongside it", () => {
    // The counter picked "10%"; a stale rupee figure in the same payload must
    // not quietly decide the bill.
    const totals = calculateTotals({
      grossSubtotal: 1000,
      discount: 400,
      discountPercent: 10,
      vatRate: 0.13,
    });
    expect(totals.discount).toBe(100);
  });

  it("treats 0% as no percentage at all, leaving the amount in charge", () => {
    const totals = calculateTotals({
      grossSubtotal: 1000,
      discount: 250,
      discountPercent: 0,
      vatRate: 0.13,
    });
    expect(totals.discount).toBe(250);
    expect(totals.discountPercent).toBe(0);
  });

  it("allows a 100% discount and refuses more", () => {
    const free = calculateTotals({
      grossSubtotal: 800,
      discountPercent: 100,
      vatRate: 0.13,
    });
    expect(free.discount).toBe(800);
    expect(free.totalAmount).toBe(0);

    expect(() =>
      calculateTotals({ grossSubtotal: 800, discountPercent: 101, vatRate: 0.13 }),
    ).toThrow(FefoError);
    expect(() =>
      calculateTotals({ grossSubtotal: 800, discountPercent: -1, vatRate: 0.13 }),
    ).toThrow(FefoError);
  });

  it("rounds VAT to two decimals", () => {
    const totals = calculateTotals({ grossSubtotal: 33.33, vatRate: 0.13 });
    expect(totals.vatAmount).toBe(4.33);
    expect(totals.totalAmount).toBe(37.66);
  });

  it("rejects a discount larger than the subtotal", () => {
    expect(() =>
      calculateTotals({ grossSubtotal: 100, discount: 150, vatRate: 0.13 }),
    ).toThrow(FefoError);
  });

  it("rejects a negative discount", () => {
    expect(() =>
      calculateTotals({ grossSubtotal: 100, discount: -1, vatRate: 0.13 }),
    ).toThrow(FefoError);
  });

  it("rejects a VAT rate expressed as a percentage instead of a fraction", () => {
    expect(() => calculateTotals({ grossSubtotal: 100, vatRate: 13 })).toThrow(FefoError);
  });
});

describe("describeShortfall", () => {
  it("names the medicine when one is supplied", () => {
    const message = describeShortfall(
      {
        medicineId: "med-A",
        requested: 10,
        available: 4,
        shortBy: 6,
        expiredUnitsIgnored: 0,
        reason: "insufficient-stock",
      },
      "Cetzine 10mg",
    );

    expect(message).toContain("Cetzine 10mg");
    expect(message).toContain("4");
    expect(message).toContain("10");
  });

  it("explains that stock exists but has expired", () => {
    const message = describeShortfall(
      {
        medicineId: "med-A",
        requested: 1,
        available: 0,
        shortBy: 1,
        expiredUnitsIgnored: 40,
        reason: "all-stock-expired",
      },
      "ORS Sachet",
    );

    expect(message).toContain("expired");
    expect(message).toContain("40");
  });
});
