import { describe, expect, it } from "vitest";
import { adIsoToBsIso } from "@/lib/bs-date";

describe("BS 2083", () => {
  it("matches the published calendar", () => {
    expect(adIsoToBsIso("2026-04-14")).toBe("2083-01-01");
    expect(adIsoToBsIso("2026-09-17")).toBe("2083-06-01");
    expect(adIsoToBsIso("2026-10-18")).toBe("2083-07-01");
    expect(adIsoToBsIso("2026-10-21")).toBe("2083-07-04");
    expect(adIsoToBsIso("2026-11-17")).toBe("2083-08-01");
    expect(adIsoToBsIso("2026-11-18")).toBe("2083-08-02");
    expect(adIsoToBsIso("2026-11-24")).toBe("2083-08-08");
  });
});
