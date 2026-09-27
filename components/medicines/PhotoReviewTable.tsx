"use client";

import { typedPrice, type PhotoImportRow } from "@/lib/medicine-import";

/**
 * The medicines read from a photo, as an editable table.
 *
 * A photo reading is a draft: a smudged digit becomes a wrong MRP and a
 * half-read name becomes a medicine nobody can find. So every cell is an
 * input, each row can be left out, and a row the last Preview flagged says
 * why right where it can be fixed. The panel regenerates the import text
 * from these rows on every change and asks for a fresh Preview, so what gets
 * saved is always what was last checked.
 */

export interface ReviewRow extends PhotoImportRow {
  key: string;
  /** Unticked rows are left out of the import. */
  include: boolean;
  purchasePrice: string;
  mrp: string;
}

export type RowStatus = { tone: "ok" | "skip" | "error"; message: string } | undefined;

const COLUMNS: Array<{
  key: keyof PhotoImportRow;
  label: string;
  width: string;
  numeric?: boolean;
  placeholder?: string;
}> = [
  { key: "name", label: "Name *", width: "min-w-[11rem]", placeholder: "Brand + strength" },
  { key: "generic", label: "Generic", width: "min-w-[9rem]" },
  { key: "manufacturer", label: "Manufacturer", width: "min-w-[9rem]" },
  { key: "category", label: "Category", width: "min-w-[7rem]" },
  { key: "unit", label: "Unit", width: "min-w-[6rem]", placeholder: "tablet" },
  { key: "packSize", label: "Pack", width: "min-w-[5rem]", placeholder: "10x10" },
  { key: "purchasePrice", label: "Cost (Rs.)", width: "min-w-[5.5rem]", numeric: true },
  { key: "mrp", label: "MRP (Rs.)", width: "min-w-[5.5rem]", numeric: true },
];

let rowCounter = 0;
export function reviewRowsFrom(rows: readonly PhotoImportRow[]): ReviewRow[] {
  return rows.map((row) => {
    rowCounter += 1;
    return {
      ...row,
      key: `photo-${rowCounter}`,
      include: true,
      purchasePrice: row.purchasePrice == null ? "" : String(row.purchasePrice),
      mrp: row.mrp == null ? "" : String(row.mrp),
    };
  });
}

export function blankReviewRow(): ReviewRow {
  return reviewRowsFrom([
    {
      name: "",
      generic: "",
      manufacturer: "",
      category: "",
      unit: "",
      packSize: "",
      purchasePrice: null,
      mrp: null,
    },
  ])[0]!;
}

export function PhotoReviewTable({
  rows,
  onChange,
  statusOf,
}: {
  rows: ReviewRow[];
  onChange: (rows: ReviewRow[]) => void;
  /** What the last Preview said about this row, if anything. */
  statusOf: (key: string) => RowStatus;
}) {
  function update(key: string, patch: Partial<ReviewRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const included = rows.filter((row) => row.include).length;

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <p className="text-xs font-medium text-slate-700">
          Review {rows.length} medicine{rows.length === 1 ? "" : "s"} read from the photo
          <span className="ml-1 font-normal text-slate-500">· {included} ticked to import</span>
        </p>
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            onClick={() => onChange(rows.map((row) => ({ ...row, include: true })))}
            className="font-medium text-brand-700 hover:underline"
          >
            Tick all
          </button>
          <button
            type="button"
            onClick={() => onChange([...rows, blankReviewRow()])}
            className="font-medium text-brand-700 hover:underline"
          >
            + Add row
          </button>
        </div>
      </div>

      <div className="max-h-[26rem] overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-2 py-1.5 font-medium">
                <span className="sr-only">Import</span>
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className={`px-1.5 py-1.5 font-medium ${column.numeric ? "text-right" : ""}`}
                >
                  {column.label}
                </th>
              ))}
              <th className="px-2 py-1.5">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => {
              const status = statusOf(row.key);
              const n = index + 1;
              return (
                <tr
                  key={row.key}
                  className={`align-top ${row.include ? "" : "bg-slate-50 text-slate-400"}`}
                >
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(event) => update(row.key, { include: event.target.checked })}
                      aria-label={`Import row ${n}`}
                      className="mt-1.5 h-4 w-4 rounded border-slate-300 text-brand-600"
                    />
                  </td>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className={`px-1 py-1 ${column.width}`}>
                      <input
                        value={String(row[column.key] ?? "")}
                        onChange={(event) =>
                          update(row.key, {
                            [column.key]: column.numeric
                              ? typedPrice(event.target.value)
                              : event.target.value,
                          } as Partial<ReviewRow>)
                        }
                        inputMode={column.numeric ? "decimal" : undefined}
                        placeholder={column.placeholder}
                        aria-label={`${column.label.replace(" *", "")} for row ${n}`}
                        disabled={!row.include}
                        className={`input px-2 py-1 text-xs ${column.numeric ? "tnum text-right" : ""} ${
                          column.key === "name" && row.include && !row.name.trim()
                            ? "border-rose-300"
                            : ""
                        }`}
                      />
                      {column.key === "name" && status ? (
                        <p
                          className={`mt-0.5 text-[11px] leading-snug ${
                            status.tone === "error"
                              ? "text-rose-600"
                              : status.tone === "skip"
                                ? "text-slate-500"
                                : "text-emerald-700"
                          }`}
                        >
                          {status.message}
                        </p>
                      ) : null}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                      aria-label={`Remove row ${n}`}
                      title="Remove this row"
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
