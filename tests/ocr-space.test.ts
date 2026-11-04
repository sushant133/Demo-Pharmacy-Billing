import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missingSerials, printedTotal, readBill, readerWarning, parsePackText } from "@/lib/medicine-ocr";
import {
  MAX_UPLOAD_BYTES,
  OcrSpaceError,
  clearOcrSpaceRest,
  linesFromReply,
  overlayToLines,
  overlayToRows,
  prepareUpload,
  readingQuality,
  readWithOcrSpace,
  textToLines,
} from "@/lib/ocr-space";

/** What engine 3 returned for a generated test bill, with no real data in it. */
const ENGINE_3_BILL = [
  "# HIMAL PHARMA DISTRIBUTORS",
  "Kathmandu, Nepal PAN: 600000001",
  "",
  "Invoice No : HPD/8283-06184",
  "",
  "Date : 23/06/2026",
  "",
  "| SN | Particulars        | Pack | Batch  | Exp      | Qty | Free | Rate   | Amount  | MRP  |",
  "|----|--------------------|------|--------|----------|-----|------|--------|---------|------|",
  "| 1  | ERICOB 90MG TAB    | 10S  | EB2041 | 04/2027  | 10  | 1    | 120.70 | 1207.00 | 140.00 |",
  "| 2  | LACRYL G 10ML      | 1 PHL| LG7788 | 12/2026  | 5   | 0    | 189.69 | 948.45  | 220.00 |",
  "| 3  | PANTOP 40 TAB      | 10X10| PT5521 | 08/2027  | 20  | 2    | 65.50  | 1310.00 | 85.00  |",
  "| 4  | AZITHRAL 500 TAB   | 3S   | AZ9910 | 02/2028  | 12  | 0    | 78.25  | 939.00  | 99.00  |",
  "",
  "**Grand Total : 4404.45**",
].join("\n");

const reply = (ParsedText: string) => ({
  OCRExitCode: 1,
  IsErroredOnProcessing: false,
  ParsedResults: [{ ParsedText, FileParseExitCode: 1 }],
});

describe("textToLines", () => {
  it("strips engine 3's Markdown and keeps each table row on one line", () => {
    const lines = textToLines(ENGINE_3_BILL).map((line) => line.text);
    expect(lines[0]).toBe("HIMAL PHARMA DISTRIBUTORS");
    expect(lines).toContain("1 ERICOB 90MG TAB 10S EB2041 04/2027 10 1 120.70 1207.00 140.00");
    expect(lines).toContain("Grand Total : 4404.45");
    expect(lines.some((line) => line.includes("---"))).toBe(false);
  });

  it("reads engine 2's tab-separated rows", () => {
    expect(textToLines("1\tPANTOP 40 TAB\t10X10\t\n")[0]!.text).toBe("1 PANTOP 40 TAB 10X10");
  });

  it("does not mistake a hyphenated line for a table rule", () => {
    expect(textToLines("Deurali-Janta")[0]!.text).toBe("Deurali-Janta");
  });
});

describe("a bill read by engine 3, through the real parser", () => {
  const bill = readBill(textToLines(ENGINE_3_BILL))!;

  it("finds every line with its numbers in the right columns", () => {
    expect(bill.lines.map((line) => [line.description, line.batch, line.expiry, line.quantity, line.rate, line.amount, line.mrp])).toEqual([
      ["ERICOB 90MG TAB", "EB2041", "04/2027", 10, 120.7, 1207, 140],
      ["LACRYL G 10ML", "LG7788", "12/2026", 5, 189.69, 948.45, 220],
      ["PANTOP 40 TAB", "PT5521", "08/2027", 20, 65.5, 1310, 85],
      ["AZITHRAL 500 TAB", "AZ9910", "02/2028", 12, 78.25, 939, 99],
    ]);
    expect(bill.lines.map((line) => line.free ?? 0)).toEqual([1, 0, 2, 0]);
  });

  it("reads the invoice number and date", () => {
    expect(bill.invoiceNo).toBe("HPD/8283-06184");
    expect(bill.invoiceDate).toBe("2026-06-23");
  });
});

describe("a pack, through the real parser", () => {
  it("takes the biggest print as the brand, wherever it sits", () => {
    const reading = parsePackText(
      overlayToLines([
        { LineText: "Pantoprazole Gastro-resistant Tablets IP 40 mg", MaxHeight: 34, MinTop: 224 },
        { LineText: "Pantop 40", MaxHeight: 101, MinTop: 91 },
        { LineText: "10 x 10 Tablets", MaxHeight: 25, MinTop: 445 },
        { LineText: "Mfg. by: Deurali-Janta Pharmaceuticals Pvt. Ltd.", MaxHeight: 26, MinTop: 540 },
        { LineText: "MRP Rs. 85.00 per strip of 10 tablets", MaxHeight: 26, MinTop: 600 },
      ]),
    );
    expect(reading.name).toBe("Pantop 40");
    expect(reading.genericName.toLowerCase()).toContain("pantoprazole");
    expect(reading.manufacturer).toContain("Deurali-Janta");
    expect(reading.mrp).toBe(85);
  });
});

/** The shape of a real faint bill as engine 3 read it: two rates misread, every amount right. */
const MISREAD_RATES = [
  "# INVOICE",
  "SNO. DESCRIPTION PACKING BATCH NO EXPIRY QUANTITY FREE RATE AMOUNT MRP, REMARKS",
  "1 G-MAX SOAP75GM 1PC GB-013 12/2027 10.00 172.40 1724.00 125.00 3.00",
  "2 FOOTCURE CREAM 75GM 1PC C-351 05/2028 6.00 344.45 2069.10 250.00 3.00",
  "3 KETOCURE POWDER 100GM 100GM DEP1102 10/2027 20.00 275.00 5500.00 300.00 3.00",
  "4 ACNIFAIR FACEWASH 60ML 60ML X-002 02/2029 5.00 375.30 1896.50 275.00 3.00",
  "5 G-MAX-C LOTION 100ML GMC-001 09/2026 5.00 303.44 1517.20 220.00 3.00",
  "TOTAL 12706.80",
  "Less:Discount Allowed 361.21",
  "NET PAYABLE AMOUNT.... 12326.00",
].join("\n");

describe("overlayToRows", () => {
  /** A table's cells as the overlay gives them, on a page leaning by `slope`. */
  const cells = (slope: number) => {
    const table = [
      ["SNO", "DESCRIPTION", "PACK", "BATCH", "EXPIRY", "QTY", "RATE", "AMOUNT", "MRP"],
      ["1", "G-MAX SOAP", "1PC", "GB-013", "12/2027", "10.00", "172.40", "1724.00", "190.00"],
      ["2", "FOOTCURE CREAM", "1PC", "C-351", "05/2028", "6.00", "344.85", "2069.10", "400.00"],
      ["3", "LOTION", "1PC", "GMC-001", "09/2027", "5.00", "303.44", "1517.20", "350.00"],
    ];
    const lefts = [20, 60, 300, 370, 470, 560, 630, 710, 800];
    // Engine 3 hands cells over column by column, so the order must not matter.
    return lefts.flatMap((left, column) =>
      table.map((row, index) => ({
        LineText: row[column]!,
        MinTop: Math.round(100 + index * 16 + left * slope),
        MaxHeight: 10,
        Words: [{ Left: left, Top: 0, Height: 10 }],
      })),
    );
  };

  it("rebuilds rows from cells given column by column", () => {
    const rows = overlayToRows(cells(0)).map((line) => line.text);
    expect(rows[1]).toBe("1 G-MAX SOAP 1PC GB-013 12/2027 10.00 172.40 1724.00 190.00");
    expect(rows).toHaveLength(4);
  });

  it("keeps rows together on a tilted page, where one drifts past the next", () => {
    // 800px across at 3%: the far end has dropped 24px, more than a whole row.
    for (const slope of [0.03, -0.03]) {
      const bill = readBill(overlayToRows(cells(slope)))!;
      expect(bill.lines.map((line) => line.amount)).toEqual([1724, 2069.1, 1517.2]);
      expect(bill.lines.every((line) => line.checked)).toBe(true);
    }
  });

  it("wins over text read column by column, from one reply", () => {
    const columnwise = "G-MAX SOAP\nFOOTCURE CREAM\nLOTION\n\n10.00\n6.00\n5.00\n\n172.40\n344.85\n303.44";
    const lines = linesFromReply(
      { ParsedResults: [{ ParsedText: columnwise, FileParseExitCode: 1, TextOverlay: { Lines: cells(0) } }], OCRExitCode: 1 },
      "list",
    );
    expect(readBill(lines)!.lines).toHaveLength(3);
  });

  it("keeps the invoice details from the text when the table comes from positions", () => {
    const text = "M/s Name : A CUSTOMER\nInvoice No : INV/42\nDate : 13/07/2026\nBATCH\nG-MAX SOAP\n10.00";
    const bill = readBill(
      linesFromReply(
        { ParsedResults: [{ ParsedText: text, FileParseExitCode: 1, TextOverlay: { Lines: cells(0) } }], OCRExitCode: 1 },
        "list",
      ),
    )!;
    expect(bill.invoiceNo).toBe("INV/42");
    expect(bill.invoiceDate).toBe("2026-07-13");
    expect(bill.lines).toHaveLength(3);
  });

  it("leaves good row text alone, on a tie", () => {
    const lines = linesFromReply(
      { ParsedResults: [{ ParsedText: ENGINE_3_BILL, FileParseExitCode: 1, TextOverlay: { Lines: cells(0) } }], OCRExitCode: 1 },
      "list",
    );
    expect(readBill(lines)!.lines).toHaveLength(4);
  });
});

describe("a bill's own total", () => {
  it("proves the amounts, so a misread rate is corrected from them", () => {
    const bill = readBill(textToLines(MISREAD_RATES))!;
    expect(bill.lines.map((line) => line.rate)).toEqual([172.4, 344.85, 275, 379.3, 303.44]);
    expect(bill.lines.every((line) => line.checked)).toBe(true);
    expect(bill.note).not.toContain("could not be read");
  });

  it("never guesses when the total disagrees: those rows stay blank and flagged", () => {
    const bill = readBill(textToLines(MISREAD_RATES.replace("12706.80", "13000.00")))!;
    expect(bill.lines.filter((line) => !line.checked)).toHaveLength(2);
    expect(bill.lines[1]!.rate).toBeNull();
    expect(bill.lines[1]!.amount).toBeNull();
    expect(bill.note).toContain("add up to Rs. 12706.80");
    expect(bill.note).toContain("Rs. 13000.00");
  });

  it("never guesses when there is no total to prove it", () => {
    const bill = readBill(textToLines(MISREAD_RATES.replace("TOTAL 12706.80\n", "")))!;
    expect(bill.lines[1]!.rate).toBeNull();
    expect(bill.note).toContain("could not be read");
  });

  it("does not take the discount or the net amount for it", () => {
    expect(printedTotal(textToLines("Less:Discount Allowed 361.21\nNET PAYABLE AMOUNT 12326.00\nTOTAL 12,706.80")))
      .toBe(12706.8);
    expect(printedTotal(textToLines("Net Total : 3,731.00\nBasic Total : 3,708.60"))).toBe(3708.6);
    expect(printedTotal(textToLines("Net Total : 3,731.00"))).toBeNull();
    expect(printedTotal(textToLines("Grand Total : 4,404.45"))).toBeNull();
  });

  it("finds it on a line run together with other text, but not a count", () => {
    expect(printedTotal(textToLines("In Words: Rupees Three Thousand Basic Total 3,708.60"))).toBe(3708.6);
    expect(printedTotal(textToLines("Total Qty 20"))).toBeNull();
  });

  it("does not guess at a row too far out to be one misread digit", () => {
    const bill = readBill(
      textToLines(["SNO. DESCRIPTION PACKING BATCH NO EXPIRY QUANTITY RATE AMOUNT MRP", "1 G-MAX SOAP 1PC GB-013 12/2027 10.00 90.00 1724.00 125.00", "TOTAL 1724.00"].join("\n")),
    )!;
    expect(bill.lines[0]!.amount).toBeNull();
    expect(bill.lines[0]!.checked).toBe(false);
  });
});

/** The table of a real bill with no expiry dates. Rate on line 10 misread: 77.80 for 77.60. */
const NO_EXPIRY_BILL = [
  "Sales Exp/Brk Return",
  "SN Product Name Pack Batch Expiry Qty Free Rate Amount MRP DIS",
  "1 HEMPUSHPA SYRUP 450ML 450MI 00 1.00 0 504.00 504.00 550.00 5.00",
  "2 INFECT-V 10T 00 1.00 0 90.13 90.13 115.00 5.00",
  "3 ZERON TABS. 10 S. 00 1.00 0 86.21 431.05 100.00 5.00",
  "4 LACRYL G 10ML 1 PHL CSGDO 09/2026 5.50 1 189.69 1,043.30 220.00 5.00",
  "5 LCZ SYP 60ML 1 PHL 00 3.00 0 60.35 181.05 77.00 5.00",
  "6 ZELLAR 60ML SYP. 1 PHL 00 3.00 0 79.03 158.06 110.00 5.00",
  "7 JANMAGHUNTI 60ML (V) 1PH 00 2.00 0 71.84 143.68 100.00 5.00",
  "8 CALCIFER DROP 15ML 1PHL 00 1.00 0 56.00 56.00 65.00 5.00",
  "9 OSTOFLEX OIL 60ML 1 PHL 00 2.00 0 158.00 316.00 220.00 5.00",
  "10 MONAST - 4MG TAB. 10 S. 00 4.00 0 77.80 310.40 90.00 5.00",
  "11 IP 3 DROP 15ML 1 PHYL 00 2.00 0 43.10 86.20 65.00 5.00",
  "12 GASEX TAB PHYL 00 2.00 0 235.00 470.00 175.00 5.00",
  "In Words: Rs.Three Thousand Six Hundred One Only Basic Total 3,789.8",
  "Net Amount 3,601.0",
].join("\n");

describe("a bill with no expiry dates and one misread rate", () => {
  const bill = readBill(textToLines(NO_EXPIRY_BILL))!;

  it("keeps the row, and the total proves its amount and rate", () => {
    expect(bill.lines).toHaveLength(12);
    expect(bill.lines[9]).toMatchObject({ quantity: 4, rate: 77.6, amount: 310.4, checked: true });
    expect(bill.lines.every((line) => line.checked)).toBe(true);
  });

  it("corrects misread quantities from the same proof, and stops doubting them", () => {
    expect(bill.lines[2]!.quantity).toBe(5);
    expect(bill.lines[5]!.quantity).toBe(2);
    expect(bill.note).not.toContain("quantity was unclear");
  });

  it("without a total to prove it, the row is kept but stays blank and flagged", () => {
    const unproven = readBill(textToLines(NO_EXPIRY_BILL.replace(" Basic Total 3,789.8", "")))!;
    expect(unproven.lines).toHaveLength(12);
    expect(unproven.lines[9]).toMatchObject({ rate: null, amount: null, checked: false });
  });
});

describe("missingSerials", () => {
  it("finds a line skipped between the rows", () => {
    expect(missingSerials([1, 2, 3, 5, 6])).toEqual([4]);
    expect(missingSerials([1, 2, 5])).toEqual([3, 4]);
  });

  it("finds nothing in an unbroken run, or starting above 1", () => {
    expect(missingSerials([1, 2, 3])).toEqual([]);
    expect(missingSerials([4, 5, 6])).toEqual([]);
  });

  it("does not trust serials that are mostly absent, out of order, or too few", () => {
    expect(missingSerials([1, null, null, null, 9])).toEqual([]);
    expect(missingSerials([1, 3, 2, 5])).toEqual([]);
    expect(missingSerials([1, 5])).toEqual([]);
    expect(missingSerials([1, 2, 30])).toEqual([]);
  });

  it("tells the owner which line to add, through the real parser", () => {
    const text = [
      "SN Product Pack Batch Expiry Qty Rate Amount MRP",
      "1 ZERON 10S AB1 09/2027 5.00 86.21 431.05 100.00",
      "2 LCZ 1PH AB2 09/2027 3.00 60.35 181.05 77.00",
      "3 MUCO 1PH AB3 09/2027 2.00 50.00 100.00 70.00",
      "5 NIKO 1PH AB4 09/2027 2.00 40.00 80.00 60.00",
    ].join("\n");
    expect(readBill(textToLines(text))!.note).toContain("Line 4 on the bill could not be read");
  });
});

describe("invoice details", () => {
  it("are found below the table when that is where they came out", () => {
    const bill = readBill(
      textToLines(
        [
          "ESTIMATE BILL",
          "S.N. Description Pack Batch Expiry Qty Rate Amount MRP",
          "1 B-COLEN SYR 1PH 25016 05/2027 5.00 147.94 739.70 170.00",
          "Invoice No. : CR/ 629",
          "Invoice Date : 06/25/2026",
          "Basic Total : 739.70",
        ].join("\n"),
      ),
    )!;
    expect(bill.invoiceNo).toBe("CR/629");
    expect(bill.invoiceDate).toBe("2026-06-25");
  });
});

describe("readerWarning", () => {
  const line = { text: "x", height: 1, confidence: 90 };

  it("is silent for engine 3, and speaks up for anything else", () => {
    expect(readerWarning([{ ...line, reader: 3 }])).toBe("");
    expect(readerWarning([{ ...line, reader: 2 }])).toContain("backup");
    expect(readerWarning([line])).toContain("backup");
  });
});

describe("what a bill photo warns about", () => {
  const row = "1 ZERON TABS 10S AB123 09/2027 5.00 86.21 431.05 100.00";
  const header = "SN Product Pack Batch Expiry Qty Rate Amount MRP";

  it("a return note, which must not be posted as a purchase", () => {
    const bill = readBill(textToLines(["Sales Exp/Brk Return", header, row].join("\n")))!;
    expect(bill.note).toContain("return or credit note");
  });

  it("but not a sale on credit", () => {
    for (const heading of ["Credit Memo", "CREDIT INVOICE"]) {
      expect(readBill(textToLines([heading, header, row].join("\n")))!.note).not.toContain("return or credit note");
    }
  });

  it("an expiry too far ahead to be real", () => {
    const dated = "DATE : 26/07/2026";
    const far = "1 CEFADYL SYP 1PH CCD-016 07/2037 10.00 228.45 2284.50 265.00";
    expect(readBill(textToLines([dated, header, far].join("\n")))!.note).toContain("too far ahead");
    expect(readBill(textToLines([dated, header, row].join("\n")))!.note).not.toContain("too far ahead");
  });

  it("an expiry before the bill's own date, usually a misread digit", () => {
    const dated = "DATE : 26/07/2026";
    const old = "1 CEFADYL SYP 1PH CCD-016 07/2021 10.00 228.45 2284.50 265.00";
    expect(readBill(textToLines([dated, header, old].join("\n")))!.note).toContain("before the bill's own date");
    expect(readBill(textToLines([dated, header, row].join("\n")))!.note).not.toContain("before the bill's own date");
    // With no date on the bill there is nothing sound to compare it to.
    expect(readBill(textToLines([header, old].join("\n")))!.note).not.toContain("before the bill's own date");
  });
});

describe("readingQuality", () => {
  const header = "SN Product Pack Batch Expiry Qty Rate Amount MRP";

  it("calls a bill with names but no numbers unusable: that is a sideways photo", () => {
    const sideways = textToLines([header, "1 PROGYMED TAB 10*10 TPG803 01/2028", "2 NORETH TAB 1*10 TNR041 01/2028"].join("\n"));
    expect(readingQuality(sideways, "list").usable).toBe(false);
  });

  it("calls a bill with one row out usable but not complete", () => {
    const lines = textToLines([header, "1 ZERON 10S AB1 09/2027 5.00 86.21 431.05 100.00", "2 LCZ 1PH AB2 09/2027 3.00 60.35 181.05 77.00", "3 ZELLAR 1PH AB3 09/2027 2.00 74.03 158.06 110.00"].join("\n"));
    expect(readingQuality(lines, "list")).toMatchObject({ usable: true, complete: false });
  });

  it("calls a bill's heading with no rows a failed reading, not a plain list", () => {
    const columns = textToLines("BATCH NO\nEXPIRY\nG-MAX SOAP 12\nFOOTCURE 6");
    expect(readingQuality(columns, "list").usable).toBe(false);
  });

  it("accepts a plain priced list without turning it", () => {
    expect(readingQuality(textToLines("Paracetamol 500mg 25.00\nCetzine 10mg 40"), "list")).toMatchObject({ usable: true, complete: true });
  });
});

describe("linesFromReply", () => {
  it("throws what the service said, so the fallback can take over", () => {
    expect(() =>
      linesFromReply({ OCRExitCode: 4, IsErroredOnProcessing: true, ErrorMessage: ["File too large"] }, "list"),
    ).toThrow("File too large");
  });

  it("counts a page that failed, or one with no text, as a failure", () => {
    expect(() =>
      linesFromReply({ ParsedResults: [{ FileParseExitCode: -20 }], OCRExitCode: 3 }, "list"),
    ).toThrow(OcrSpaceError);
    expect(() => linesFromReply(reply("  \n "), "list")).toThrow("No text");
  });
});

describe("prepareUpload", () => {
  it("brings a heavy photo under the limit, as a JPEG", async () => {
    const noise = randomBytes(1500 * 1500 * 3);
    const heavy = await sharp(noise, { raw: { width: 1500, height: 1500, channels: 3 } }).png().toBuffer();
    expect(heavy.byteLength).toBeGreaterThan(MAX_UPLOAD_BYTES);

    const out = await prepareUpload(heavy);
    expect(out.byteLength).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    expect((await sharp(out).metadata()).format).toBe("jpeg");
  });

  it("does not enlarge a small photo", async () => {
    const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#fff" } }).png().toBuffer();
    expect((await sharp(await prepareUpload(small)).metadata()).width).toBe(400);
  });
});

describe("a refused key", () => {
  it("says so, rather than an unknown exit code", () => {
    expect(() => linesFromReply({ error: "E555: API key not valid" }, "list")).toThrow("E555");
    expect(() => linesFromReply("The API key is invalid", "list")).toThrow("The API key is invalid");
  });
});

describe("readWithOcrSpace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearOcrSpaceRest();
  });
  const photo = () => sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toBuffer();

  it("moves to the next engine when the first is out of allowance", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("You may only perform this action upto maximum 1000 times", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply("PANTOP 40 TAB 10 65.50 655.00"))));
    vi.stubGlobal("fetch", fetchMock);

    const lines = await readWithOcrSpace(await photo(), "list");
    expect(lines[0]!.text).toBe("PANTOP 40 TAB 10 65.50 655.00");
    expect((fetchMock.mock.calls[0]![1].body as FormData).get("OCREngine")).toBe("3");
    expect((fetchMock.mock.calls[1]![1].body as FormData).get("OCREngine")).toBe("2");
  });

  it("turns a sideways photo until the rows make sense, and stops there", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply("ERICOB\n90MG\nTAB"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply("ERICOB 90MG TAB 10 120.70 1207.00"))));
    vi.stubGlobal("fetch", fetchMock);

    const lines = await readWithOcrSpace(await photo(), "list");
    expect(lines[0]!.text).toBe("ERICOB 90MG TAB 10 120.70 1207.00");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves a rate-limited engine alone until its time is up", async () => {
    const limited = new Response(JSON.stringify({ error: "E582: Rate limit exceeded", retryAfter: 2008 }), { status: 429 });
    const good = () => new Response(JSON.stringify(reply("PANTOP 40 TAB 10 65.50 655.00")));
    const fetchMock = vi.fn().mockResolvedValueOnce(limited).mockImplementation(async () => good());
    vi.stubGlobal("fetch", fetchMock);
    const engineOf = (call: number) => (fetchMock.mock.calls[call]![1].body as FormData).get("OCREngine");

    const first = await readWithOcrSpace(await photo(), "list");
    expect(first[0]!.reader).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The next scan does not knock on engine 3's door at all.
    await readWithOcrSpace(await photo(), "list");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(engineOf(2)).toBe("2");
  });

  it("gives up cleanly when every engine is resting, for the local reader to take over", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "E582", retryAfter: 2008 }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readWithOcrSpace(await photo(), "list")).rejects.toThrow("E582");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(readWithOcrSpace(await photo(), "list")).rejects.toThrow("resting");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not spend a second request improving a backup engine's reading", async () => {
    const header = "SN Product Pack Batch Expiry Qty Rate Amount MRP";
    const imperfect = [header, "1 ZERON 10S AB1 09/2027 5.00 86.21 431.05 100.00", "2 LCZ 1PH AB2 09/2027 3.00 60.35"].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "E582", retryAfter: 2008 }), { status: 429 }))
      .mockImplementation(async () => new Response(JSON.stringify(reply(imperfect))));
    vi.stubGlobal("fetch", fetchMock);
    await readWithOcrSpace(await photo(), "list");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads an imperfect bill once more and keeps the better reading", async () => {
    const header = "SN Product Pack Batch Expiry Qty Rate Amount MRP";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply([header, "1 ZERON 10S AB1 09/2027 5.00 86.21 431.05 100.00", "2 LCZ 1PH AB2 09/2027 3.00 60.35", "3 MUCO 1PH AB3 09/2027 2.00 50.00 100.00 70.00"].join("\n")))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply([header, "1 ZERON 10S AB1 09/2027 5.00 86.21 431.05 100.00", "2 LCZ 1PH AB2 09/2027 3.00 60.35 181.05 77.00", "3 MUCO 1PH AB3 09/2027 2.00 50.00 100.00 70.00"].join("\n")))));
    vi.stubGlobal("fetch", fetchMock);

    const bill = readBill(await readWithOcrSpace(await photo(), "list"))!;
    expect(bill.lines.every((line) => line.checked)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops at one request when the bill reads clean", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply(ENGINE_3_BILL))));
    vi.stubGlobal("fetch", fetchMock);
    await readWithOcrSpace(await photo(), "list");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the first reading when no turn does better", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply("Paracetamol\nCetzine"))));
    vi.stubGlobal("fetch", fetchMock);

    const lines = await readWithOcrSpace(await photo(), "list");
    expect(lines.map((line) => line.text)).toEqual(["Paracetamol", "Cetzine"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws when every engine fails, and asks for table mode only on a bill", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readWithOcrSpace(await photo(), "pack")).rejects.toThrow("network down");
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get("isOverlayRequired")).toBe("true");
    expect(form.get("isTable")).toBeNull();
  });
});
