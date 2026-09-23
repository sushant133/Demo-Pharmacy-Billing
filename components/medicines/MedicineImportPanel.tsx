"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { amount } from "@/lib/format";
import { IMPORT_TEMPLATE_HEADER, jsonToCsv } from "@/lib/medicine-import";
import { SlideOver } from "@/components/SlideOver";
import { Badge } from "@/components/ui";

/**
 * Bring a catalogue in from a spreadsheet.
 *
 * Preview first, always. The panel asks the server what *would* happen, shows
 * it, and only writes when the user presses Import - so the destructive-looking
 * button is pressed by somebody who has already read the consequences. Nothing
 * about the file is trusted from the browser on the second call; the server
 * re-reads the catalogue, because a colleague may have added a medicine in the
 * seconds in between.
 *
 * A file is read into the same textarea the user could have pasted into,
 * rather than uploaded as multipart. It keeps one code path, it lets somebody
 * fix a bad row in place instead of going back to Excel, and it makes the
 * thing being imported visible rather than a filename. JSON is converted in
 * the browser and Excel on the server, both into that same CSV text.
 */

/** Human names for the fields a column can be matched to. */
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  genericName: "Generic",
  saltComposition: "Salt composition",
  manufacturer: "Manufacturer",
  category: "Category",
  unit: "Unit",
  packSize: "Pack size",
  sku: "SKU",
  barcode: "Barcode",
  unitsPerStrip: "Units per strip",
  defaultCostPrice: "Purchase price",
  defaultSalePrice: "MRP",
  reorderLevel: "Reorder level",
  requiresPrescription: "Rx",
};

interface PreviewRow {
  line: number;
  name: string;
  genericName: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  defaultCostPrice: number | null;
  defaultSalePrice: number | null;
  requiresPrescription: boolean;
}

interface ImportReport {
  total: number;
  columns: string[];
  mapping?: Array<{ header: string; field: string | null }>;
  preview?: PreviewRow[];
  ignored: string[];
  willCreate: number;
  duplicates: Array<{ line: number; name: string; reason: string }>;
  errors: Array<{ line: number; name: string; error: string }>;
  sample: Array<{ line: number; name: string; manufacturer: string; category: string }>;
  created: number;
  skippedOnWrite?: number;
  dryRun: boolean;
}

export function MedicineImportPanel({
  returnHref = "/medicines",
}: {
  returnHref?: string;
}) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  async function run(dryRun: boolean) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch<ImportReport>("/api/medicines/import", {
      method: "POST",
      json: { csv, dryRun },
    });

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setReport(result.data);
    if (!dryRun) router.refresh();
  }

  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  /** Any supported file into the textarea as CSV, whatever it arrived as. */
  async function readFile(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    setError(null);
    // The file may not match what was previewed a moment ago.
    setReport(null);

    if (extension === "xls") {
      setError(
        "Older .xls workbooks cannot be read. Open it in Excel and save it as .xlsx or CSV.",
      );
      return;
    }

    setReading(true);
    try {
      if (extension === "xlsx") {
        const result = await apiFetch<{ csv: string; sheet: string }>(
          "/api/medicines/import/excel",
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: await file.arrayBuffer(),
          },
        );
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setCsv(result.data.csv);
        setFileName(`${file.name} · sheet “${result.data.sheet}”`);
        return;
      }

      const text = await file.text();
      const looksJson =
        extension === "json" || /^\s*[[{]/.test(text.slice(0, 100));
      if (looksJson) {
        try {
          setCsv(jsonToCsv(text));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "That JSON could not be read.");
          return;
        }
      } else {
        setCsv(text);
      }
      setFileName(file.name);
    } finally {
      setReading(false);
    }
  }

  const done = report !== null && !report.dryRun;

  return (
    <SlideOver
      title={done ? "Import finished" : "Bulk add medicines"}
      description={
        done
          ? undefined
          : "Upload a CSV, Excel or JSON file, or paste rows from a spreadsheet. Columns are matched automatically, and nothing is saved until you have seen the preview."
      }
      onClose={close}
      footer={
        done ? (
          <button type="button" onClick={close} className="btn-primary w-full">
            Done
          </button>
        ) : (
          <div className="flex gap-2">
            {report ? (
              <button
                type="button"
                onClick={() => run(false)}
                disabled={busy || report.willCreate === 0}
                className="btn-primary flex-1"
              >
                {busy
                  ? "Saving…"
                  : `Save ${report.willCreate} medicine${report.willCreate === 1 ? "" : "s"}`}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => run(true)}
                disabled={busy || reading || csv.trim().length === 0}
                className="btn-primary flex-1"
              >
                {busy ? "Checking…" : "Preview"}
              </button>
            )}
            <button type="button" onClick={close} className="btn-secondary">
              Cancel
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        {done ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <p className="text-sm font-semibold text-emerald-900">
                {report.created} medicine{report.created === 1 ? "" : "s"} added
              </p>
              <p className="mt-0.5 text-xs text-emerald-800">
                From {report.total} row{report.total === 1 ? "" : "s"} in the file.
              </p>
            </div>

            {report.duplicates.length > 0 ? (
              <Note tone="slate" title={`${report.duplicates.length} skipped as duplicates`}>
                Already in the catalogue, or repeated in the file. Existing
                medicines are never overwritten by an import.
              </Note>
            ) : null}

            {report.errors.length > 0 ? (
              <Note tone="amber" title={`${report.errors.length} row(s) could not be read`}>
                Those lines were left out; everything else was imported. Fix
                them in the spreadsheet and run the import again.
              </Note>
            ) : null}
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="import-csv" className="label">
                Rows
              </label>
              <textarea
                id="import-csv"
                value={csv}
                onChange={(event) => {
                  setCsv(event.target.value);
                  setReport(null);
                  setFileName(null);
                }}
                rows={8}
                spellCheck={false}
                placeholder={`${IMPORT_TEMPLATE_HEADER}\nCetzine 10mg,Cetirizine,Deurali-Janta,Antihistamine,tablet,10x10,,,10,1.20,2.50,100,No`}
                className="input font-mono text-[11px] leading-relaxed"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <label className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">
                  {reading ? "Reading the file…" : "Upload CSV, Excel or JSON"}
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.json,.xlsx,.xls,text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    disabled={reading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      // Cleared so choosing the same file again still fires.
                      event.target.value = "";
                      if (file) void readFile(file);
                    }}
                  />
                </label>
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE_HEADER + "\n")}`}
                  download="medicines-template.csv"
                  className="text-xs font-medium text-slate-500 hover:text-brand-700 hover:underline"
                >
                  Download the template
                </a>
              </div>
              {fileName ? (
                <p className="mt-1.5 text-[11px] text-slate-600">
                  Loaded <span className="font-medium">{fileName}</span>
                </p>
              ) : null}
              <p className="mt-1.5 text-[11px] text-slate-500">
                The first line is the column headings. Only Name is required;
                common spellings such as &ldquo;MRP&rdquo;, &ldquo;Purchase
                price&rdquo; and &ldquo;Generic&rdquo; are recognised, and
                columns that are not are ignored.
              </p>
            </div>

            {report ? (
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={report.willCreate > 0 ? "green" : "slate"}>
                    {report.willCreate} to add
                  </Badge>
                  {report.duplicates.length > 0 ? (
                    <Badge tone="slate">
                      {report.duplicates.length} already there
                    </Badge>
                  ) : null}
                  {report.errors.length > 0 ? (
                    <Badge tone="amber">{report.errors.length} with problems</Badge>
                  ) : null}
                  <span className="text-[11px] text-slate-500">
                    of {report.total} row{report.total === 1 ? "" : "s"}
                  </span>
                </div>

                {report.mapping && report.mapping.length > 0 ? (
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-slate-500">
                      Columns detected
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {report.mapping
                        .filter((column) => column.header)
                        .map((column, index) => (
                          <span
                            key={`${column.header}-${index}`}
                            className={
                              column.field
                                ? "rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-900"
                                : "rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-400 line-through"
                            }
                            title={column.field ? undefined : "Not a medicine field - ignored"}
                          >
                            {column.header}
                            {column.field &&
                            FIELD_LABELS[column.field] &&
                            FIELD_LABELS[column.field]!.toLowerCase() !==
                              column.header.trim().toLowerCase()
                              ? ` → ${FIELD_LABELS[column.field]}`
                              : ""}
                          </span>
                        ))}
                    </div>
                  </div>
                ) : report.ignored.length > 0 ? (
                  <p className="text-[11px] text-slate-500">
                    Columns ignored: {report.ignored.join(", ")}
                  </p>
                ) : null}

                {report.preview && report.preview.length > 0 ? (
                  <div className="rounded-lg border border-slate-200">
                    <p className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500">
                      Preview — will be added in this order
                      {report.willCreate > report.preview.length
                        ? ` (first ${report.preview.length} of ${report.willCreate} shown)`
                        : ""}
                    </p>
                    <div className="max-h-80 overflow-auto">
                      <table className="w-full text-left text-[11px]">
                        <thead className="sticky top-0 bg-slate-50 text-slate-500">
                          <tr>
                            <th className="px-2 py-1 font-medium">Line</th>
                            <th className="px-2 py-1 font-medium">Name</th>
                            <th className="px-2 py-1 font-medium">Generic</th>
                            <th className="px-2 py-1 font-medium">Manufacturer</th>
                            <th className="px-2 py-1 font-medium">Category</th>
                            <th className="px-2 py-1 font-medium">Unit</th>
                            <th className="px-2 py-1 font-medium">Pack</th>
                            <th className="px-2 py-1 text-right font-medium">Cost</th>
                            <th className="px-2 py-1 text-right font-medium">MRP</th>
                            <th className="px-2 py-1 font-medium">Rx</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700">
                          {report.preview.map((row) => (
                            <tr key={row.line}>
                              <td className="px-2 py-1 text-slate-400">{row.line}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-medium text-slate-800">
                                {row.name}
                              </td>
                              <td className="px-2 py-1">{row.genericName || "—"}</td>
                              <td className="px-2 py-1">{row.manufacturer || "—"}</td>
                              <td className="px-2 py-1">{row.category || "—"}</td>
                              <td className="px-2 py-1">{row.unit || "—"}</td>
                              <td className="px-2 py-1">{row.packSize || "—"}</td>
                              <td className="whitespace-nowrap px-2 py-1 text-right">
                                {row.defaultCostPrice === null ? "—" : amount(row.defaultCostPrice)}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1 text-right">
                                {row.defaultSalePrice === null ? "—" : amount(row.defaultSalePrice)}
                              </td>
                              <td className="px-2 py-1">{row.requiresPrescription ? "Yes" : "No"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : report.sample.length > 0 ? (
                  <div className="rounded-lg border border-slate-200">
                    <p className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500">
                      First few to be added
                    </p>
                    <ul className="divide-y divide-slate-100">
                      {report.sample.map((row) => (
                        <li
                          key={row.line}
                          className="flex items-baseline justify-between gap-2 px-3 py-1.5 text-xs"
                        >
                          <span className="min-w-0 truncate text-slate-800">
                            {row.name}
                            {row.manufacturer ? (
                              <span className="text-slate-400">
                                {" "}
                                · {row.manufacturer}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[10px] text-slate-400">
                            line {row.line}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {report.errors.length > 0 ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50">
                    <p className="border-b border-amber-200 px-3 py-1.5 text-[11px] font-medium text-amber-900">
                      These rows will be skipped
                    </p>
                    <ul className="divide-y divide-amber-100">
                      {report.errors.slice(0, 12).map((row) => (
                        <li key={row.line} className="px-3 py-1.5 text-xs text-amber-900">
                          <span className="font-medium">Line {row.line}</span>
                          {row.name ? ` · ${row.name}` : ""} — {row.error}
                        </li>
                      ))}
                    </ul>
                    {report.errors.length > 12 ? (
                      <p className="px-3 py-1.5 text-[11px] text-amber-800">
                        and {report.errors.length - 12} more.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {report.willCreate === 0 ? (
                  <Note tone="slate" title="Nothing to add">
                    Every readable row is already in the catalogue. Existing
                    medicines are never overwritten by an import.
                  </Note>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </SlideOver>
  );
}

function Note({
  tone,
  title,
  children,
}: {
  tone: "slate" | "amber";
  title: string;
  children: React.ReactNode;
}) {
  const skin =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${skin}`}>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-0.5 text-xs opacity-90">{children}</p>
    </div>
  );
}
