import { describe, expect, it } from "vitest";
import { toInvoicePdf, type InvoiceData } from "@/lib/export/invoice-pdf";
import {
  PRINT_TEMPLATES,
  PRINT_TEMPLATE_LIST,
  mmToPt,
} from "@/lib/print-templates";

/**
 * The downloaded invoice, on each shop's own paper.
 *
 * A pharmacy that prints on a 58mm roll should get a 58mm PDF, not an A4 one
 * it has to scale by hand at the counter. What is worth protecting is that
 * the declared page really is the paper the template names, and that a short
 * bill does not get split across two sheets - the failure that follows from
 * laying every size out with A4's measurements.
 */

function invoice(items: number): InvoiceData {
  return {
    billNo: "INV-2082-83-000412",
    issuedAt: new Date("2025-09-21T12:57:00Z"),
    bsDate: "2082-06-05 (05 Ashwin 2082)",
    fiscalYear: "2082/83",
    issuer: {
      name: "Sample Pharmacy",
      address: "Putalisadak, Kathmandu",
      phone: "01-4567890",
      pan: "301234567",
      vatNumber: "301234567",
      email: "counter@sample.com.np",
    },
    buyer: {
      name: "Sita Kumari Shrestha",
      address: "Bagbazar, Kathmandu",
      phone: "9801234567",
      pan: "609876543",
    },
    items: Array.from({ length: items }, (_, index) => ({
      medicineName: `Amoxycillin + Clavulanic Acid 625mg tablet ${index + 1}`,
      batchNumber: `AMX22${index}0`,
      expiryDate: "Aug 2027",
      quantity: 10,
      unit: "tab",
      unitPrice: 28,
      subtotal: 280,
    })),
    subtotal: 1400,
    discount: 70,
    discountPercent: 5,
    taxableAmount: 1330,
    vatRate: 0.13,
    vatAmount: 172.9,
    totalAmount: 1502.9,
    amountReceived: 1000,
    paymentMode: "cash",
    soldByName: "Ramesh Thapa",
    branchName: "Main counter",
    note: "",
    terms: "Goods once sold are not returnable except as required by law.",
    footerNote: "Thank you.",
    voided: false,
    reprintCount: 0,
  };
}

/** pdfkit writes one /MediaBox per page; the first is the page size. */
function mediaBox(pdf: Buffer): [number, number] {
  const match = pdf.toString("latin1").match(/\/MediaBox \[([^\]]+)\]/);
  if (!match?.[1]) throw new Error("no /MediaBox in the rendered PDF");
  const box = match[1].trim().split(/\s+/).map(Number);
  if (box.length !== 4) throw new Error(`unreadable /MediaBox: ${match[1]}`);
  return [box[2] as number, box[3] as number];
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
}

describe("page size", () => {
  it("is the paper the template names", async () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      const [w, h] = mediaBox(await toInvoicePdf(invoice(3), template.id));
      expect(w, template.id).toBeCloseTo(mmToPt(template.paperWidthMm), 1);
      if (template.paperHeightMm !== null) {
        expect(h, template.id).toBeCloseTo(mmToPt(template.paperHeightMm), 1);
      }
    }
  });

  it("gives a roll enough length to finish the bill in one cut", async () => {
    // A roll has no page height; too short and the totals are cut in half.
    const short = mediaBox(await toInvoicePdf(invoice(1), "thermal-80"))[1];
    const long = mediaBox(await toInvoicePdf(invoice(20), "thermal-80"))[1];
    expect(long).toBeGreaterThan(short);
    expect(pageCount(await toInvoicePdf(invoice(20), "thermal-80"))).toBe(1);
  });

  it("falls back to the default paper for an id it does not know", async () => {
    const [w] = mediaBox(await toInvoicePdf(invoice(2), "a3-poster"));
    expect(w).toBeCloseTo(mmToPt(PRINT_TEMPLATES["thermal-80"].paperWidthMm), 1);
  });
});

describe("pagination", () => {
  it("keeps an everyday bill on one sheet", async () => {
    for (const id of ["a5-portrait", "a4-portrait", "letter-portrait"] as const) {
      expect(pageCount(await toInvoicePdf(invoice(5), id)), id).toBe(1);
    }
  });

  it("prints a sheet per copy the template asks for", async () => {
    expect(PRINT_TEMPLATES["a4-duplicate"].copies).toHaveLength(2);
    expect(pageCount(await toInvoicePdf(invoice(1), "a4-duplicate"))).toBe(2);
  });

  it("flows a long order onto further sheets rather than losing lines", async () => {
    const pages = pageCount(await toInvoicePdf(invoice(40), "a4-portrait"));
    expect(pages).toBeGreaterThan(1);
  });
});

describe("what ends up on the paper", () => {
  it("renders something for every template, voided or reprinted", async () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      const pdf = await toInvoicePdf(
        { ...invoice(2), voided: true, reprintCount: 3 },
        template.id,
      );
      expect(pdf.byteLength, template.id).toBeGreaterThan(1000);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("survives a bill with no buyer, no note and nothing received", async () => {
    const bare: InvoiceData = {
      ...invoice(1),
      buyer: { name: "", address: "", phone: "", pan: "" },
      discount: 0,
      discountPercent: 0,
      amountReceived: 0,
      terms: "",
      footerNote: "",
    };
    for (const id of ["thermal-58", "a4-portrait", "dotmatrix-wide"] as const) {
      expect(pageCount(await toInvoicePdf(bare, id)), id).toBeGreaterThan(0);
    }
  });
});
