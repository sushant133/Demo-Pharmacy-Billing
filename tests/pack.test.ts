import { describe, expect, it } from "vitest";
import {
  canSellLoose,
  describePurchaseQuantity,
  describeQuantity,
  describeStock,
  formatUnitCount,
  parsePackSize,
  resolveUnitsPerStrip,
  stripLabel,
  unitWord,
} from "@/lib/pack";

describe("parsePackSize", () => {
  it("reads box and strip markings the way packs are printed", () => {
    expect(parsePackSize("10x10")).toEqual({ strips: 10, pieces: 10 });
    expect(parsePackSize("1x10")).toEqual({ strips: 1, pieces: 10 });
    expect(parsePackSize("1×3")).toEqual({ strips: 1, pieces: 3 });
    expect(parsePackSize("5*2")).toEqual({ strips: 5, pieces: 2 });
    expect(parsePackSize("10")).toEqual({ strips: 1, pieces: 10 });
  });

  it("ignores bottles and free text", () => {
    expect(parsePackSize("100ml")).toBeNull();
    expect(parsePackSize("1 vial")).toBeNull();
    expect(parsePackSize("")).toBeNull();
  });
});

describe("resolveUnitsPerStrip", () => {
  it("uses the last number of 10x10 / 1x10 as tablets in the strip", () => {
    expect(resolveUnitsPerStrip("tablet", "10x10")).toBe(10);
    expect(resolveUnitsPerStrip("tablet", "1x10")).toBe(10);
    expect(resolveUnitsPerStrip("tablet", "1x3")).toBe(3);
    expect(resolveUnitsPerStrip("tablet", "2x15")).toBe(15);
  });

  it("reads 5×2 as one strip of 10, the way the foil is laid out", () => {
    expect(resolveUnitsPerStrip("capsule", "5x2")).toBe(10);
    expect(resolveUnitsPerStrip("tablet", "2x5")).toBe(10);
  });

  it("lets a saved value win, so a 5×2 blister of 10 can be stored as 10", () => {
    expect(resolveUnitsPerStrip("tablet", "5x2", 10)).toBe(10);
  });

  it("does not split bottles, tubes or vials", () => {
    expect(resolveUnitsPerStrip("syrup", "100ml")).toBe(1);
    expect(resolveUnitsPerStrip("injection", "1 vial")).toBe(1);
    expect(canSellLoose("tablet")).toBe(true);
    expect(canSellLoose("syrup")).toBe(false);
  });
});

describe("describeQuantity", () => {
  it("leads with a plain tablet count a customer would say", () => {
    expect(describeQuantity(4, 10, "tablet")).toBe(
      "4 tablets (from a strip of 10)",
    );
    expect(describeQuantity(6, 10, "tablet")).toBe(
      "6 tablets (from a strip of 10)",
    );
    expect(describeQuantity(10, 10, "tablet")).toBe("1 strip (10 tablets)");
    expect(describeQuantity(14, 10, "tablet")).toBe("14 tablets (1 strip + 4)");
  });

  it("explains a 5×2 strip as a plain tablet count, not 3×2", () => {
    expect(describeQuantity(6, 10, "tablet")).toBe(
      "6 tablets (from a strip of 10)",
    );
    expect(describeQuantity(6, 2, "tablet")).toBe("6 tablets (3 × 2)");
  });
});

describe("describePurchaseQuantity", () => {
  it("warns when a GRN looks like strips typed as tablets", () => {
    expect(describePurchaseQuantity(2, 10, "tablet")).toBe(
      "2 tablets. If you received 2 strips, enter 20.",
    );
    expect(describePurchaseQuantity(20, 10, "tablet")).toBe("2 strips (20 tablets)");
  });
});

describe("describeStock", () => {
  it("keeps the tablet count first", () => {
    expect(describeStock(180, 10, "tablet")).toBe("180 tablets · 18 strips");
    expect(describeStock(14, 10, "tablet")).toBe("14 tablets · 1 strip + 4");
    expect(formatUnitCount(1, "tablet")).toBe("1 tablet");
    expect(unitWord("capsule", 4)).toBe("capsules");
    expect(stripLabel(10, "tablet")).toBe("strip of 10 tablets");
  });
});
