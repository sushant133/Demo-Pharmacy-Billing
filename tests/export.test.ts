import { describe, expect, it } from "vitest";
import { escapeCsvField, toCsv, toCsvBuffer } from "@/lib/export/csv";
import {
  computeTotals,
  contentDisposition,
  filenameFor,
  formatCell,
  hasTotals,
  type ReportDataset,
} from "@/lib/export/dataset";

const iso = (value: Date) => value.toISOString().slice(0, 10);

const dataset: ReportDataset = {
  title: "Sales Register",
  subtitle: "1 Aug 2026 - 31 Aug 2026",
  generatedAt: new Date("2026-09-01T00:00:00Z"),
  meta: [{ label: "Branch", value: "main" }],
  columns: [
    { key: "billNo", header: "Bill no", type: "text" },
    { key: "date", header: "Date", type: "date" },
    { key: "units", header: "Units", type: "integer", total: true },
    { key: "amount", header: "Amount", type: "money", total: true },
  ],
  rows: [
    {
      billNo: "INV-000001",
      date: new Date("2026-08-14T04:00:00Z"),
      units: 3,
      amount: 226,
    },
    { billNo: "INV-000002", date: new Date("2026-08-15T04:00:00Z"), units: 2, amount: 113.5 },
  ],
};

describe("escapeCsvField - RFC 4180 quoting", () => {
  it("leaves a plain field alone", () => {
    expect(escapeCsvField("Cetzine 10mg")).toBe("Cetzine 10mg");
  });

  it("quotes a field containing a comma", () => {
    expect(escapeCsvField("Shrestha, Rajesh")).toBe('"Shrestha, Rajesh"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(escapeCsvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("passes an empty field through", () => {
    expect(escapeCsvField("")).toBe("");
  });
});

describe("escapeCsvField - formula injection", () => {
  // Export content includes names typed at the counter, so a cell beginning
  // with an operator must never be handed to Excel as a live formula.
  it("neutralises a leading equals", () => {
    expect(escapeCsvField("=1+1")).toBe("'=1+1");
  });

  it("neutralises the other formula triggers", () => {
    expect(escapeCsvField("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(escapeCsvField("-2+3")).toBe("'-2+3");
    expect(escapeCsvField("@import")).toBe("'@import");
  });

  it("neutralises the classic command-injection payload and still quotes it", () => {
    const payload = '=cmd|"/c calc"!A1';
    const escaped = escapeCsvField(payload);
    expect(escaped.startsWith("\"'=cmd")).toBe(true);
    expect(escaped).not.toBe(payload);
  });

  it("does not mangle an ordinary negative number written as text", () => {
    // Still prefixed - correctness of the guard beats cosmetics, and numeric
    // columns bypass this path entirely (see the toCsv tests).
    expect(escapeCsvField("-5")).toBe("'-5");
  });
});

describe("toCsv", () => {
  it("emits the title block, header and rows", () => {
    const lines = toCsv(dataset, { formatDate: iso }).split("\r\n");
    expect(lines[0]).toBe("Sales Register");
    expect(lines[1]).toBe("1 Aug 2026 - 31 Aug 2026");
    expect(lines[2]).toBe("Branch,main");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Bill no,Date,Units,Amount");
  });

  it("writes numbers raw so Excel parses them as numeric", () => {
    const lines = toCsv(dataset, { formatDate: iso }).split("\r\n");
    // Not "226.00" and no thousands separator.
    expect(lines[5]).toBe("INV-000001,2026-08-14,3,226");
    expect(lines[6]).toBe("INV-000002,2026-08-15,2,113.5");
  });

  it("appends a totals row for flagged columns only", () => {
    const lines = toCsv(dataset, { formatDate: iso }).split("\r\n");
    expect(lines[lines.length - 1]).toBe("Total,,5,339.5");
  });

  it("can omit the title block for a machine-readable file", () => {
    const lines = toCsv(dataset, {
      formatDate: iso,
      includeHeaderBlock: false,
    }).split("\r\n");
    expect(lines[0]).toBe("Bill no,Date,Units,Amount");
  });

  it("uses CRLF line endings", () => {
    expect(toCsv(dataset, { formatDate: iso })).toContain("\r\n");
  });

  it("handles an empty dataset without a totals row", () => {
    const empty = { ...dataset, rows: [] };
    const lines = toCsv(empty, { formatDate: iso }).split("\r\n");
    expect(lines[lines.length - 1]).toBe("Bill no,Date,Units,Amount");
  });

  it("escapes a medicine name containing a comma", () => {
    const risky: ReportDataset = {
      ...dataset,
      rows: [{ billNo: "Vitamin B1, B6, B12", date: null, units: 1, amount: 10 }],
    };
    expect(toCsv(risky, { formatDate: iso })).toContain('"Vitamin B1, B6, B12"');
  });
});

describe("toCsvBuffer", () => {
  it("prefixes a UTF-8 BOM so Excel on Windows reads it correctly", () => {
    const buffer = toCsvBuffer(dataset, { formatDate: iso });
    expect([buffer[0], buffer[1], buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("round-trips non-ASCII text", () => {
    const nepali: ReportDataset = {
      ...dataset,
      rows: [{ billNo: "सिटीजिन", date: null, units: 1, amount: 5 }],
    };
    expect(toCsvBuffer(nepali).toString("utf8")).toContain("सिटीजिन");
  });
});

describe("formatCell", () => {
  it("renders money and numbers to two decimals", () => {
    expect(formatCell(226, "money", iso)).toBe("226.00");
    expect(formatCell(1.005, "number", iso)).toBe("1.01");
  });

  it("rounds integers", () => {
    expect(formatCell(3.7, "integer", iso)).toBe("4");
  });

  it("suffixes percentages", () => {
    expect(formatCell(42.35, "percent", iso)).toBe("42.4%");
  });

  it("renders empty for null, undefined and non-finite numbers", () => {
    expect(formatCell(null, "money", iso)).toBe("");
    expect(formatCell(undefined, "text", iso)).toBe("");
    expect(formatCell(Number.NaN, "money", iso)).toBe("");
    expect(formatCell(Number.POSITIVE_INFINITY, "money", iso)).toBe("");
  });

  it("delegates dates to the supplied formatter", () => {
    expect(formatCell(new Date("2026-08-14T00:00:00Z"), "date", iso)).toBe("2026-08-14");
  });
});

describe("computeTotals", () => {
  it("totals only flagged numeric columns", () => {
    expect(computeTotals(dataset)).toEqual({ units: 5, amount: 339.5 });
  });

  it("ignores non-numeric cells rather than producing NaN", () => {
    const messy: ReportDataset = {
      ...dataset,
      rows: [
        { billNo: "a", date: null, units: 2, amount: 10 },
        { billNo: "b", date: null, units: null, amount: "n/a" },
      ],
    };
    expect(computeTotals(messy)).toEqual({ units: 2, amount: 10 });
  });

  it("reports whether any column wants a total", () => {
    expect(hasTotals(dataset)).toBe(true);
    expect(
      hasTotals({ ...dataset, columns: [{ key: "a", header: "A", type: "text" }] }),
    ).toBe(false);
  });
});

describe("filenames and headers", () => {
  it("slugs the title and stamps the date", () => {
    expect(filenameFor(dataset, "csv")).toBe("sales-register-2026-09-01.csv");
  });

  it("strips characters that would break a filename", () => {
    const awkward = { ...dataset, title: "Sales / Profit: Q1 *2026*" };
    expect(filenameFor(awkward, "xlsx")).toBe("sales-profit-q1-2026-2026-09-01.xlsx");
  });

  it("falls back to a default stem when the title has nothing usable", () => {
    expect(filenameFor({ ...dataset, title: "///" }, "pdf")).toBe(
      "report-2026-09-01.pdf",
    );
  });

  it("cannot break out of the Content-Disposition header", () => {
    // A supplier name with a quote and a newline must not inject a header.
    const header = contentDisposition('evil".pdf\r\nX-Injected: yes');
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header.match(/"/g)?.length).toBe(2);
  });

  it("includes an RFC 5987 fallback for non-ASCII names", () => {
    expect(contentDisposition("बिक्री.csv")).toContain("filename*=UTF-8''");
  });
});
