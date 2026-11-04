import { describe, expect, it } from "vitest";
import {
  backoffMs,
  billPayload,
  cbmsFiscalYear,
  parseCbmsResponse,
  returnPayload,
} from "@/lib/cbms";

const credentials = { username: "shop", password: "secret", sellerPan: "601234567" };

const sale = {
  billNo: "INV-2082-83-000042",
  fiscalYear: "2082-83",
  // 2026-01-15 10:00 in Kathmandu.
  createdAt: new Date("2026-01-15T04:15:00Z"),
  customerName: "Ram Traders",
  customerPan: "301234567",
  totalAmount: 1052,
  taxableAmount: 1000,
  exemptAmount: 600,
  vatAmount: 52,
};

describe("cbmsFiscalYear", () => {
  it("writes the fiscal year the way IRD's API does", () => {
    expect(cbmsFiscalYear("2082-83")).toBe("2082.083");
  });
});

describe("billPayload", () => {
  const payload = billPayload(sale, credentials, true, new Date("2026-01-15T04:15:05Z"));

  it("names seller, buyer, invoice and fiscal year", () => {
    expect(payload.seller_pan).toBe("601234567");
    expect(payload.buyer_pan).toBe("301234567");
    expect(payload.buyer_name).toBe("Ram Traders");
    expect(payload.invoice_number).toBe("INV-2082-83-000042");
    expect(payload.fiscal_year).toBe("2082.083");
  });

  it("dates the invoice in Bikram Sambat", () => {
    expect(payload.invoice_date).toMatch(/^2082\.10\.\d{2}$/);
  });

  it("splits exempt and taxable sales", () => {
    expect(payload.total_sales).toBe(1052);
    expect(payload.taxable_sales_vat).toBe(400);
    expect(payload.tax_exempted_sales).toBe(600);
    expect(payload.vat).toBe(52);
  });

  it("sends the client time in Nepal", () => {
    expect(payload.datetimeClient).toBe("2026-01-15T10:00:05");
    expect(payload.isrealtime).toBe(true);
  });
});

describe("returnPayload", () => {
  it("refers back to the original invoice", () => {
    const payload = returnPayload(
      sale,
      {
        creditNoteNo: "CN-2082-83-000003",
        issuedAt: new Date("2026-01-20T06:00:00Z"),
        reason: "Damaged pack",
        totalAmount: 113,
        taxableAmount: 100,
        exemptAmount: 0,
        vatAmount: 13,
      },
      credentials,
      false,
    );
    expect(payload.ref_invoice_number).toBe("INV-2082-83-000042");
    expect(payload.credit_note_number).toBe("CN-2082-83-000003");
    expect(payload.reason_for_return).toBe("Damaged pack");
    expect(payload.taxable_sales_vat).toBe(100);
    expect(payload.isrealtime).toBe(false);
  });
});

describe("parseCbmsResponse", () => {
  it("reads the bare status code IRD answers with", () => {
    expect(parseCbmsResponse("200")).toBe(200);
    expect(parseCbmsResponse('"101"')).toBe(101);
    expect(parseCbmsResponse('{"status":104}')).toBe(104);
    expect(parseCbmsResponse("<html>gateway error</html>")).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from a minute and stops at six hours", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(30)).toBe(6 * 60 * 60 * 1000);
  });
});
