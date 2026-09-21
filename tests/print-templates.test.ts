import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRINT_TEMPLATE,
  PRINT_TEMPLATES,
  PRINT_TEMPLATE_IDS,
  PRINT_TEMPLATE_LIST,
  hasColumn,
  isPrintTemplateId,
  mmToPt,
  pageRule,
  printTemplate,
  receiptVars,
} from "@/lib/print-templates";
import { formatThermalReceipt, type ThermalReceipt } from "@/lib/receipt-text";
import { printTemplateSchema } from "@/lib/validation";

/**
 * The catalogue of bill layouts.
 *
 * What is worth protecting here is the promise the templates make: the paper
 * changes shape, the invoice does not lose a field. Nepali VAT Rules 2053
 * require the batch, the quantity, the rate, the taxable value and the VAT on
 * the document, and a narrow roll is allowed to stack them but not to drop
 * them.
 */

describe("the catalogue", () => {
  it("covers every printer a pharmacy is likely to own", () => {
    const kinds = new Set(PRINT_TEMPLATE_LIST.map((template) => template.kind));
    expect(kinds).toEqual(new Set(["thermal", "sheet", "dotmatrix"]));
  });

  it("keeps content inside the paper", () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      const printable = template.paperWidthMm - template.marginMm * 2;
      expect(
        template.contentWidthMm,
        `${template.id} lays out wider than its paper`,
      ).toBeLessThanOrEqual(printable);
      expect(template.contentWidthMm).toBeGreaterThan(0);
    }
  });

  it("prints the money column on every template", () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      expect(hasColumn(template, "amount"), template.id).toBe(true);
      expect(hasColumn(template, "item"), template.id).toBe(true);
    }
  });

  it("offers the ESC/POS route only to roll printers", () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      if (template.kind === "thermal") {
        expect(template.escposColumns, template.id).toBeGreaterThan(0);
        expect(template.layout).toBe("roll");
      } else {
        // A sheet printer that were offered the Bluetooth button would give
        // the counter a printer that never answers.
        expect(template.escposColumns, template.id).toBeNull();
      }
    }
  });

  it("gives a sheet room for the columns a roll has to stack", () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      if (template.layout !== "table") continue;
      expect(hasColumn(template, "qty"), template.id).toBe(true);
      expect(hasColumn(template, "rate"), template.id).toBe(true);
    }
  });

  it("lists every id exactly once, in one order", () => {
    expect(PRINT_TEMPLATE_LIST.map((template) => template.id)).toEqual([
      ...PRINT_TEMPLATE_IDS,
    ]);
    for (const id of PRINT_TEMPLATE_IDS) {
      expect(PRINT_TEMPLATES[id].id).toBe(id);
    }
  });

  it("prints at least one document per template", () => {
    for (const template of PRINT_TEMPLATE_LIST) {
      expect(template.copies.length, template.id).toBeGreaterThan(0);
    }
  });
});

describe("resolving a stored id", () => {
  it("falls back to the roll every pharmacy could already print", () => {
    // A shop carrying the id of a withdrawn template still has to be able to
    // hand a customer a bill.
    expect(printTemplate("no-such-template").id).toBe(DEFAULT_PRINT_TEMPLATE);
    expect(printTemplate(null).id).toBe(DEFAULT_PRINT_TEMPLATE);
    expect(printTemplate(undefined).id).toBe(DEFAULT_PRINT_TEMPLATE);
    expect(printTemplate("")).toBe(PRINT_TEMPLATES[DEFAULT_PRINT_TEMPLATE]);
  });

  it("returns the asked-for template when it is real", () => {
    expect(printTemplate("a4-portrait").id).toBe("a4-portrait");
  });

  it("recognises its own ids and nothing else", () => {
    expect(isPrintTemplateId("thermal-58")).toBe(true);
    expect(isPrintTemplateId("A4-PORTRAIT")).toBe(false);
    expect(isPrintTemplateId(80)).toBe(false);
    expect(isPrintTemplateId(null)).toBe(false);
  });

  it("only lets superadmin save a layout that exists", () => {
    expect(printTemplateSchema.safeParse({ printTemplate: "a5-portrait" }).success).toBe(
      true,
    );
    expect(printTemplateSchema.safeParse({ printTemplate: "a3-poster" }).success).toBe(
      false,
    );
  });
});

describe("page rule", () => {
  it("asks for a continuous cut on a roll, and a sheet otherwise", () => {
    expect(pageRule(PRINT_TEMPLATES["thermal-80"])).toBe(
      "@page { size: 80mm auto; margin: 2mm; }",
    );
    expect(pageRule(PRINT_TEMPLATES["a4-portrait"])).toBe(
      "@page { size: 210mm 297mm; margin: 12mm; }",
    );
  });

  it("hands the stylesheet a width and a body size", () => {
    const vars = receiptVars(PRINT_TEMPLATES["thermal-58"]);
    expect(vars["--receipt-width"]).toBe("54mm");
    expect(vars["--receipt-font"]).toBe("9px");
  });
});

describe("mmToPt", () => {
  it("converts to the points pdfkit measures pages in", () => {
    expect(mmToPt(25.4)).toBe(72);
    expect(mmToPt(210)).toBeCloseTo(595.28, 1);
    expect(mmToPt(297)).toBeCloseTo(841.89, 1);
  });
});

/**
 * The ESC/POS path is where a wrong width does visible damage: a 42-column
 * receipt sent to a 58mm printer wraps every total onto its own ragged line.
 */
describe("thermal text at the template's width", () => {
  const receipt: ThermalReceipt = {
    shop: "Sagarmatha Pharmacy",
    pan: "301234567",
    copyLabel: "ORIGINAL",
    billNo: "INV-2082/83-000001",
    dateAd: "05 Sep 2026, 14:05",
    payment: "Cash",
    buyer: "Walk-in customer",
    items: [{ name: "Pantop 40mg", detail: "4 tab x 10.00", amount: "40.00" }],
    subtotal: "40.00",
    taxable: "40.00",
    vatLabel: "VAT 13%",
    vatAmount: "5.20",
    total: "45.20",
    words: "Rupees forty five and twenty paisa only",
  };

  it("never exceeds the columns the printer has", () => {
    for (const width of [32, 42]) {
      for (const line of formatThermalReceipt(receipt, width)) {
        expect(line.length, `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("rules off at exactly the paper width", () => {
    const narrow = formatThermalReceipt(receipt, 32);
    expect(narrow).toContain("-".repeat(32));
    expect(narrow).not.toContain("-".repeat(42));
  });

  it("still defaults to the 80mm line when nobody says otherwise", () => {
    expect(formatThermalReceipt(receipt)).toContain("-".repeat(42));
  });

  it("uses each thermal template's own column count", () => {
    const columns = PRINT_TEMPLATE_LIST.filter(
      (template) => template.escposColumns !== null,
    ).map((template) => template.escposColumns as number);

    for (const width of columns) {
      const lines = formatThermalReceipt(receipt, width);
      expect(lines.some((line) => line === "-".repeat(width))).toBe(true);
    }
  });
});
