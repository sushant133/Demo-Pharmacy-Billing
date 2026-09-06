import { describe, expect, it } from "vitest";
import { encodeEscPos } from "@/lib/escpos";
import {
  formatThermalReceipt,
  padLine,
  wrapWords,
  type ThermalReceipt,
} from "@/lib/receipt-text";

const sample: ThermalReceipt = {
  shop: "Sagarmatha Pharmacy",
  pan: "301234567",
  copyLabel: "ORIGINAL",
  billNo: "INV-2082/83-000001",
  dateAd: "05 Sep 2026, 14:05",
  payment: "Cash",
  buyer: "Walk-in customer",
  items: [
    {
      name: "Pantop 40mg",
      detail: "4 tablets x Rs 10.00",
      amount: "Rs 40.00",
    },
  ],
  subtotal: "Rs 40.00",
  taxable: "Rs 40.00",
  vatLabel: "VAT 13%",
  vatAmount: "Rs 5.20",
  total: "Rs 45.20",
  words: "Rupees forty five and twenty paisa only",
};

describe("padLine", () => {
  it("puts the amount on the right edge", () => {
    expect(padLine("TOTAL", "Rs 45.20", 20)).toBe("TOTAL       Rs 45.20");
    expect(padLine("TOTAL", "Rs 45.20", 20).length).toBe(20);
  });
});

describe("wrapWords", () => {
  it("breaks a long shop name onto the next line", () => {
    const lines = wrapWords("Sagarmatha Community Pharmacy Pvt Ltd", 16);
    expect(lines.every((line) => line.length <= 16)).toBe(true);
    expect(lines.join(" ")).toContain("Sagarmatha");
  });
});

describe("formatThermalReceipt", () => {
  it("starts with TAX INVOICE and ends with a cut-ready thank you", () => {
    const lines = formatThermalReceipt(sample);
    expect(lines[0]).toBe("TAX INVOICE");
    expect(lines).toContain("PAN: 301234567");
    expect(lines.some((line) => line.includes("Pantop"))).toBe(true);
    expect(lines.some((line) => line.includes("TOTAL"))).toBe(true);
    expect(lines.at(-2)).toBe("Thank you");
  });
});

describe("encodeEscPos", () => {
  it("starts with the init command so the printer resets", () => {
    const bytes = encodeEscPos(["TAX INVOICE", "Shop"]);
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
    expect(bytes.length).toBeGreaterThan(8);
  });
});
