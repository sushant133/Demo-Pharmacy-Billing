import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  expiryToDate,
  invoiceMeta,
  sheetToBill,
  tidyExpiry,
  tidyInvoiceDate,
  toPurchaseQuantities,
  unitsPerPack,
} from "@/lib/bill-import";
import { readBill, type OcrLine } from "@/lib/medicine-ocr";

const fixture = (name: string): OcrLine[] =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ocr-bills", `${name}.json`), "utf8"));

describe("every column of a photographed bill", () => {
  it("reads description, pack, batch, expiry, qty, free, rate, amount and MRP", () => {
    const bill = readBill(fixture("murarka"))!;
    expect(bill.lines).toEqual([
      {
        description: "ERICOB 90MG TAB",
        pack: "10S",
        batch: "TET98107",
        expiry: "04/2027",
        quantity: 10,
        free: 5,
        rate: 120.7,
        amount: 1207,
        mrp: 140,
        checked: true,
      },
      {
        description: "LACRYL G 10ML",
        pack: "1 PHL",
        // Printed ECSGD004; the photo's 4 is under a pen stroke.
        batch: "ECSGDO0",
        expiry: "09/2026",
        quantity: 5.5,
        free: 0.5,
        rate: 189.69,
        amount: 1043.3,
        mrp: 220,
        checked: true,
      },
      {
        description: "IDFLO EYE /EAR DROP 5ML",
        pack: "1 PHL",
        batch: "EOFEOQ11",
        expiry: "02/2028",
        quantity: 10,
        free: 2,
        rate: 68.97,
        amount: 689.7,
        mrp: 80,
        checked: true,
      },
      {
        description: "CLOTRIBEST 10ML",
        pack: "1 PHL",
        batch: "ACLE002",
        expiry: "01/2028",
        quantity: 5,
        free: 1,
        rate: 68.97,
        amount: 344.85,
        mrp: 80,
        checked: true,
      },
    ]);
  });

  it("reads batches, expiries and free quantities on a bill with pen ticks", () => {
    const bill = readBill(fixture("estimate"))!;
    expect(bill.lines.map((line) => [line.batch, line.expiry, line.quantity, line.free, line.amount])).toEqual([
      ["25016", "05/2027", 5, 1, 739.7],
      ["3400AR", "04/2027", 2.5, 0.5, 258.7],
      ["MB-135", "03/2027", 2.5, 0.5, 224.5],
      ["25051109", "11/2027", 3, 0, 254.1],
      ["NKT26560", "02/2029", 15, 0, 129.3],
      ["AMIGE254039D", "04/2027", 10, 0, 82.5],
      ["TB519", "05/2027", 5.5, 0.5, 437.03],
      ["DPC260544", "02/2029", 11, 1, 271.15],
      // Pack and batch printed glued together: 30ML | MPJ253614.
      ["MPI253614", "02/2027", 2, 0, 224.36],
      ["483", "06/2027", 5, 5, 431.05],
      ["MPB260564", "01/2028", 5.5, 0.5, 656.21],
    ]);
  });
});

describe("dates", () => {
  it("reads expiry however it is written", () => {
    expect(tidyExpiry("04/2027")).toBe("04/2027");
    expect(tidyExpiry("4/27")).toBe("04/2027");
    expect(tidyExpiry("O5-2O28")).toBe("05/2028");
    expect(tidyExpiry("Apr-27")).toBe("04/2027");
    expect(tidyExpiry("2027-04-30")).toBe("04/2027");
    expect(tidyExpiry("30/04/2027")).toBe("04/2027");
    expect(tidyExpiry("13/2027")).toBe("");
    expect(tidyExpiry("12/202")).toBe("");
  });

  it("takes a lot as good to the end of its expiry month", () => {
    expect(expiryToDate("04/2027")).toBe("2027-04-30");
    expect(expiryToDate("02/2028")).toBe("2028-02-29");
    expect(expiryToDate("")).toBe("");
  });

  it("reads invoice dates day first, unless the day cannot be", () => {
    expect(tidyInvoiceDate("Date : 23/06/2026")).toBe("2026-06-23");
    expect(tidyInvoiceDate("Invoice Date : 06/25/2026")).toBe("2026-06-25");
    expect(tidyInvoiceDate("DATE : 13/07/2026")).toBe("2026-07-13");
    // Bikram Sambat - the "Miti" line - is not an AD date.
    expect(tidyInvoiceDate("2083/03/09")).toBe("");
  });

  it("finds the invoice number and date above the table", () => {
    expect(
      invoiceMeta(["M/s Name : A CUSTOMER    Invoice N. : MDH/8283-06184", "Miti : 2083/03/09", "Date : 23/06/2026"]),
    ).toEqual({ invoiceNo: "MDH/8283-06184", invoiceDate: "2026-06-23" });
    expect(invoiceMeta(["INVOICE NO: 000561", "DATE : 13/07/2026", "PRINT DATE: 14/07/2026"])).toEqual({
      invoiceNo: "000561",
      invoiceDate: "2026-07-13",
    });
  });
});

describe("packs to pieces", () => {
  it("reads pieces per pack from the bill's pack", () => {
    expect(unitsPerPack("10 S", "tablet")).toBe(10);
    expect(unitsPerPack("15'S", "tablet")).toBe(15);
    expect(unitsPerPack("10x10", "tablet")).toBe(10);
    expect(unitsPerPack("1x15", "capsule")).toBe(15);
    expect(unitsPerPack("60ML", "syrup")).toBe(1);
    expect(unitsPerPack("10 S", "unit")).toBe(1);
  });

  it("turns a strip line into tablets at per-tablet prices", () => {
    expect(toPurchaseQuantities({ quantity: 10, free: 5, rate: 120.7, amount: 1207, mrp: 140 }, 10)).toEqual({
      quantity: 100,
      freeQuantity: 50,
      costPrice: 12.07,
      salePrice: 14,
      explanation: "",
    });
  });

  it("takes a fractional bill as the whole delivery at the billed amount", () => {
    // 5.50 billed + 0.50 free = 6 bottles for 1043.30.
    expect(toPurchaseQuantities({ quantity: 5.5, free: 0.5, rate: 189.69, amount: 1043.3, mrp: 220 }, 1)).toEqual({
      quantity: 6,
      freeQuantity: 0,
      costPrice: 173.8833,
      salePrice: 220,
      explanation: "5.5 + 0.5 free = 6 received for the billed amount.",
    });
  });

  it("refuses what cannot be whole pieces, or has no price", () => {
    expect(toPurchaseQuantities({ quantity: 2.5, free: 0, rate: 10, amount: 25, mrp: 12 }, 1)).toHaveProperty("error");
    expect(toPurchaseQuantities({ quantity: 2, free: 0, rate: 10, amount: 20, mrp: null }, 1)).toEqual({
      error: "Enter the MRP.",
    });
  });
});

describe("a supplier's spreadsheet", () => {
  const csv = [
    "MURARKA DRUG HOUSE,,,,,,,,",
    "Invoice No : MDH/8283-06184,,,,Date : 23/06/2026,,,,",
    "S.N.,Item Description,Pack,Batch,Expiry,Quantity,Free,Rate,Amount,Mrp,Dis%",
    '1,ERICOB 90MG TAB,10 S,TET98107,04/2027,10.00,5.00,120.70,"1,207.00",140.00,5.00',
    "2,LACRYL G 10ML,1 PHL,ECSGD004,2026-09-30,5.50,0.50,189.69,1043.30,220.00,5.00",
    ",Basic Total,,,,,,,3284.85,,",
  ].join("\n");

  it("finds the heading row under the letterhead and reads every column", () => {
    const bill = sheetToBill(csv);
    expect(bill.invoiceNo).toBe("MDH/8283-06184");
    expect(bill.invoiceDate).toBe("2026-06-23");
    expect(bill.letterhead[0]).toBe("MURARKA DRUG HOUSE");
    expect(bill.lines).toEqual([
      {
        description: "ERICOB 90MG TAB",
        pack: "10 S",
        batch: "TET98107",
        expiry: "04/2027",
        quantity: 10,
        free: 5,
        rate: 120.7,
        amount: 1207,
        mrp: 140,
        checked: true,
      },
      {
        description: "LACRYL G 10ML",
        pack: "1 PHL",
        batch: "ECSGD004",
        expiry: "09/2026",
        quantity: 5.5,
        free: 0.5,
        rate: 189.69,
        amount: 1043.3,
        mrp: 220,
        checked: true,
      },
    ]);
  });

  it("flags a row whose numbers contradict each other", () => {
    const bill = sheetToBill("Item,Batch,Expiry,Qty,Rate,Amount,MRP\nCETZINE,B1,05/27,10,2.5,30,3");
    expect(bill.lines[0]?.checked).toBe(false);
  });

  it("says what is missing when there is no item header", () => {
    expect(sheetToBill("a,b,c\n1,2,3").note).toMatch(/No item columns found/);
  });
});
