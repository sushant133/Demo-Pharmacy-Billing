import { describe, expect, it } from "vitest";
import { fillHourlyBuckets } from "@/lib/analytics";

describe("fillHourlyBuckets", () => {
  it("covers the shop window even when nothing has sold", () => {
    const points = fillHourlyBuckets([]);
    expect(points[0]?.hour).toBe(8);
    expect(points[points.length - 1]?.hour).toBe(20);
    expect(points.every((point) => point.billCount === 0 && point.amount === 0)).toBe(
      true,
    );
  });

  it("pads zeros inside the window so a quiet hour is a real zero", () => {
    const points = fillHourlyBuckets([
      { hour: 10, amount: 500, billCount: 2 },
      { hour: 12, amount: 100, billCount: 1 },
    ]);
    const ten = points.find((point) => point.hour === 10);
    const eleven = points.find((point) => point.hour === 11);
    expect(ten?.amount).toBe(500);
    expect(eleven?.amount).toBe(0);
    expect(eleven?.billCount).toBe(0);
  });

  it("expands the window when a bill lands outside shop hours", () => {
    const points = fillHourlyBuckets([{ hour: 22, amount: 80, billCount: 1 }]);
    expect(points[0]?.hour).toBe(8);
    expect(points[points.length - 1]?.hour).toBe(22);
    expect(points.find((point) => point.hour === 22)?.amount).toBe(80);
  });

  it("labels hours with a two-digit clock", () => {
    const points = fillHourlyBuckets([]);
    expect(points.find((point) => point.hour === 8)?.label).toBe("08");
    expect(points.find((point) => point.hour === 14)?.label).toBe("14");
  });
});
