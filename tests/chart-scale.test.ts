import { describe, expect, it } from "vitest";
import {
  bandCentres,
  compactNumber,
  donutSlicePath,
  horizontalBarPath,
  linePath,
  niceScale,
  polar,
  scaleY,
  thinLabels,
  verticalBarPath,
} from "@/lib/chart-scale";

/**
 * Axis maths is where a chart quietly lies - a truncated baseline or a tick
 * that lands on 437 rather than 500. These are cheap to pin down, so they are.
 */

describe("niceScale", () => {
  it("always starts the domain at zero", () => {
    // A truncated baseline exaggerates differences; bars and money never get one.
    expect(niceScale(1234).ticks[0]).toBe(0);
  });

  it("rounds the maximum up to a readable step", () => {
    expect(niceScale(1234)).toEqual({ max: 1500, ticks: [0, 500, 1000, 1500] });
    expect(niceScale(97)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
  });

  it("never produces a maximum below the data", () => {
    for (const value of [1, 7, 99, 101, 1_000_001, 3.7]) {
      expect(niceScale(value).max).toBeGreaterThanOrEqual(value);
    }
  });

  it("keeps ticks evenly spaced", () => {
    const { ticks } = niceScale(880);
    const gaps = ticks.slice(1).map((tick, i) => tick - ticks[i]!);
    expect(new Set(gaps).size).toBe(1);
  });

  it("degrades safely for zero, negative and non-finite input", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(-5)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it("handles small fractional maxima without float drift", () => {
    const { ticks } = niceScale(0.4);
    expect(ticks.every((tick) => Number.isFinite(tick))).toBe(true);
    // 0.1 steps must not come back as 0.30000000000000004.
    expect(ticks.every((tick) => String(tick).length <= 4)).toBe(true);
  });
});

describe("scaleY", () => {
  it("puts zero on the baseline and the max at the top", () => {
    expect(scaleY(0, 100, 200, 10)).toBe(210);
    expect(scaleY(100, 100, 200, 10)).toBe(10);
  });

  it("places the midpoint halfway", () => {
    expect(scaleY(50, 100, 200, 0)).toBe(100);
  });

  it("clamps out-of-range values instead of drawing outside the plot", () => {
    expect(scaleY(150, 100, 200, 0)).toBe(0);
    expect(scaleY(-50, 100, 200, 0)).toBe(200);
  });

  it("falls back to the baseline when the domain is empty", () => {
    expect(scaleY(5, 0, 200, 0)).toBe(200);
  });
});

describe("bandCentres", () => {
  it("centres a lone point", () => {
    expect(bandCentres(1, 100)).toEqual([50]);
  });

  it("spans the full width for several points", () => {
    expect(bandCentres(3, 100)).toEqual([0, 50, 100]);
  });

  it("returns nothing for no points", () => {
    expect(bandCentres(0, 100)).toEqual([]);
  });
});

describe("thinLabels", () => {
  it("keeps every label when they all fit", () => {
    expect(thinLabels(5, 8).every(Boolean)).toBe(true);
  });

  it("thins down towards the budget when they do not", () => {
    const kept = thinLabels(30, 8).filter(Boolean).length;
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThanOrEqual(10);
  });

  it("always keeps the last label, which carries the direct value", () => {
    const keep = thinLabels(30, 8);
    expect(keep[keep.length - 1]).toBe(true);
  });

  it("handles an empty axis", () => {
    expect(thinLabels(0, 8)).toEqual([]);
  });
});

describe("compactNumber", () => {
  it("abbreviates thousands and millions", () => {
    expect(compactNumber(1500)).toBe("1.5k");
    expect(compactNumber(2_400_000)).toBe("2.4M");
  });

  it("leaves small numbers alone", () => {
    expect(compactNumber(45)).toBe("45");
    expect(compactNumber(0)).toBe("0");
  });

  it("drops a trailing zero decimal", () => {
    expect(compactNumber(2000)).toBe("2k");
  });

  it("handles negatives", () => {
    expect(compactNumber(-1500)).toBe("-1.5k");
  });
});

describe("path builders", () => {
  it("builds a polyline that starts with a move", () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 5, y: 20 }])).toBe("M0 10 L5 20");
  });

  it("returns an empty path for no points", () => {
    expect(linePath([])).toBe("");
  });

  it("rounds only the data end of a bar, leaving the baseline square", () => {
    const path = horizontalBarPath(0, 0, 100, 18, 4);
    // Starts square at the baseline, arcs only at the far end.
    expect(path.startsWith("M0 0 h96")).toBe(true);
    expect(path.match(/a4 4/g)?.length).toBe(2);
  });

  it("degrades to a plain rect when the bar is too small to round", () => {
    expect(horizontalBarPath(0, 0, 2, 18, 4)).not.toContain("a4 4");
  });

  it("produces no path for a zero-width bar", () => {
    expect(horizontalBarPath(0, 0, 0, 18, 4)).toContain("h0");
  });

  it("rounds only the top of a column, leaving the baseline square", () => {
    const path = verticalBarPath(0, 0, 12, 40, 3);
    expect(path.startsWith("M0 3")).toBe(true);
    expect(path.match(/a3 3/g)?.length).toBe(2);
    expect(path.endsWith("h-12 Z")).toBe(true);
  });

  it("produces no path for a zero-height column", () => {
    expect(verticalBarPath(0, 0, 12, 0, 3)).toBe("");
  });
});

describe("donut geometry", () => {
  it("places angle 0 at 12 o'clock", () => {
    expect(polar(100, 100, 50, 0)).toEqual({ x: 100, y: 50 });
  });

  it("places angle 90 at 3 o'clock", () => {
    expect(polar(100, 100, 50, 90)).toEqual({ x: 150, y: 100 });
  });

  it("draws a quarter slice as a small arc", () => {
    const path = donutSlicePath(100, 100, 50, 30, 0, 90);
    expect(path).toContain("A50 50 0 0 1");
    expect(path).toContain("A30 30 0 0 0");
  });

  it("uses a large-arc flag past 180 degrees", () => {
    const path = donutSlicePath(100, 100, 50, 30, 0, 270);
    expect(path).toContain("A50 50 0 1 1");
  });

  it("draws a full ring without a 360-degree arc", () => {
    const path = donutSlicePath(100, 100, 50, 30, 0, 360);
    expect(path).toContain("A50 50 0 1 1");
    expect(path).toContain("A30 30 0 1 0");
  });

  it("returns empty for a zero sweep", () => {
    expect(donutSlicePath(100, 100, 50, 30, 10, 10)).toBe("");
  });
});
