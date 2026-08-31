import { describe, expect, it } from "vitest";
import { amountInWords } from "@/lib/money-words";
import { displayBillNo, formatBillNo } from "@/models/Counter";

describe("amountInWords", () => {
  it("formats rupees and paisa for an IRD total line", () => {
    expect(amountInWords(101700)).toBe(
      "One lakh one thousand seven hundred rupees only",
    );
    expect(amountInWords(12.5)).toBe("Twelve rupees and fifty paisa only");
    expect(amountInWords(1)).toBe("One rupee only");
  });
});

describe("formatBillNo", () => {
  it("embeds the fiscal year without a slash so the bill URL stays one segment", () => {
    expect(formatBillNo(42, "2082-83")).toBe("INV-2082-83-000042");
    expect(displayBillNo("INV-2082-83-000042")).toBe("INV-2082/83-000042");
  });

  it("leaves legacy numbers unchanged", () => {
    expect(displayBillNo("INV-000173")).toBe("INV-000173");
  });
});
