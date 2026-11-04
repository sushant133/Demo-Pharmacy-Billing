"use client";

import { useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { shrinkPhoto } from "@/lib/photo";
import {
  expiryToDate,
  lineAddsUp,
  tidyExpiry,
  toPurchaseQuantities,
  unitsPerPack,
  type BillLine,
  type PurchaseQuantities,
} from "@/lib/bill-import";
import { defaultVatExempt } from "@/lib/constants";
import { canSellLoose } from "@/lib/pack";
import { Combobox, type ComboOption } from "@/components/Combobox";
import type { MedicineOption } from "@/components/purchases/PurchaseForm";

/**
 * Bring a supplier's bill into the purchase form: a photo of the paper bill,
 * or the supplier's Excel / CSV export.
 *
 * Either way the bill comes back as its own lines - item, pack, batch,
 * expiry, quantity, free, rate, amount, MRP - in an editable preview, each
 * matched to a catalogue medicine where one is close enough. Nothing is
 * saved here: "Add to purchase" creates any medicine the shop does not have
 * yet and fills the form's lines, which are saved (and posted) as usual.
 */

interface ReadLine extends BillLine {
  medicineId: string | null;
  medicineName: string | null;
  unitsPerPack: number;
  unit: string;
}

interface ReadResult {
  source: "photo" | "sheet";
  lines: ReadLine[];
  invoiceNo: string;
  invoiceDate: string;
  supplierId: string | null;
  note: string;
}

interface Row {
  key: string;
  include: boolean;
  medicineId: string;
  description: string;
  pack: string;
  batch: string;
  expiry: string;
  quantity: string;
  free: string;
  rate: string;
  amount: string;
  mrp: string;
  unitsPerPack: string;
  unit: string;
  /** The reader's own verdict: its numbers added up. */
  read: boolean;
  /** Only used if this line becomes a new medicine. */
  vatExempt: boolean;
}

/** Forms offered for a new medicine; any other word the shop types is kept as typed. */
const FORMS = [
  "tablet",
  "capsule",
  "syrup",
  "suspension",
  "drops",
  "injection",
  "cream",
  "ointment",
  "gel",
  "lotion",
  "powder",
  "sachet",
  "inhaler",
  "soap",
  "solution",
  "unit",
];

/** What the form receives: purchase lines in pieces, and the medicines created for them. */
export interface ImportedBill {
  lines: Array<{
    medicineId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    freeQuantity: number;
    costPrice: number;
    salePrice: number;
  }>;
  created: MedicineOption[];
  invoiceNo: string;
  invoiceDate: string;
  supplierId: string | null;
}

const text = (value: number | null) => (value == null ? "" : String(value));
const number = (value: string): number | null => {
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

function toRow(line: ReadLine, index: number): Row {
  return {
    key: `bill-${index}`,
    include: true,
    medicineId: line.medicineId ?? "",
    description: line.description,
    pack: line.pack,
    batch: line.batch,
    expiry: line.expiry,
    quantity: text(line.quantity),
    free: text(line.free ?? 0),
    rate: text(line.rate),
    amount: text(line.amount),
    mrp: text(line.mrp),
    unitsPerPack: String(line.unitsPerPack),
    unit: line.unit,
    read: line.checked,
    vatExempt: defaultVatExempt(null, line.description),
  };
}

/** A row's problems, and - when it has none - what it becomes on the purchase. */
function checkRow(row: Row): { problems: string[]; result: PurchaseQuantities | null } {
  const problems: string[] = [];
  if (!row.medicineId && row.description.trim().length < 2) problems.push("Name the medicine.");
  if (!row.batch.trim()) problems.push("Batch is missing.");
  if (!expiryToDate(tidyExpiry(row.expiry))) problems.push("Expiry should be MM/YYYY.");
  const perPack = number(row.unitsPerPack);
  if (!perPack || perPack < 1 || !Number.isInteger(perPack)) problems.push("Pieces per pack must be a whole number.");

  let result: PurchaseQuantities | null = null;
  if (perPack && perPack >= 1 && Number.isInteger(perPack)) {
    const converted = toPurchaseQuantities(
      {
        quantity: number(row.quantity),
        free: number(row.free),
        rate: number(row.rate),
        amount: number(row.amount),
        mrp: number(row.mrp),
      },
      perPack,
    );
    if ("error" in converted) problems.push(converted.error);
    else result = converted;
  }
  return { problems, result };
}

export function BillImport({
  medicines,
  onApply,
  onClose,
}: {
  medicines: MedicineOption[];
  onApply: (bill: ImportedBill) => void;
  onClose: () => void;
}) {
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const createdMedicines = useRef(new Map<string, MedicineOption>());

  const medicineOptions = useMemo<ComboOption[]>(
    () =>
      medicines.map((medicine) => ({
        value: medicine.id,
        label: medicine.name,
        detail: [medicine.manufacturer, medicine.packSize].filter(Boolean).join(" · ") || undefined,
        keywords: medicine.genericName,
      })),
    [medicines],
  );
  const medicineById = useMemo(() => new Map(medicines.map((medicine) => [medicine.id, medicine])), [medicines]);

  async function read(file: File, kind: "photo" | "sheet") {
    setError(null);
    setReading(true);
    try {
      let body: Blob = file;
      if (kind === "photo") {
        try {
          body = await shrinkPhoto(file);
        } catch {
          setError("That photo could not be opened. Use a JPG or PNG image.");
          return;
        }
      }
      const response = await apiFetch<ReadResult>(`/api/purchases/import?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": body.type || file.type || "application/octet-stream" },
        body,
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setResult(response.data);
      setRows(response.data.lines.map(toRow));
    } finally {
      setReading(false);
    }
  }

  function update(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  /**
   * A new medicine's form or pack changed: pieces per pack follow, since a
   * "10 S" strip of tablets is 10 pieces but a bottle is always one.
   */
  function updateShape(row: Row, patch: Pick<Partial<Row>, "unit" | "pack">) {
    const next = { ...row, ...patch };
    update(row.key, { ...patch, unitsPerPack: String(unitsPerPack(next.pack, next.unit || "unit")) });
  }

  /** Choosing a catalogue medicine takes its strip size, so pieces follow the catalogue. */
  function chooseMedicine(key: string, medicineId: string) {
    const medicine = medicineById.get(medicineId);
    update(key, {
      medicineId,
      ...(medicine ? { unitsPerPack: String(medicine.unitsPerStrip ?? 1), unit: medicine.unit } : {}),
    });
  }

  const checked = rows.map((row) => ({ row, ...checkRow(row) }));
  const included = checked.filter(({ row }) => row.include);
  const blocked = included.filter(({ problems }) => problems.length > 0).length;
  const newNames = new Set(
    included.filter(({ row }) => !row.medicineId).map(({ row }) => row.description.trim().toLowerCase()),
  );

  async function apply() {
    if (!result || blocked > 0 || included.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      // Medicines the shop does not have yet: created once each, from the bill.
      // Remembered across attempts, so a retry after a failure partway through
      // does not try to create the ones that already went through.
      const created = createdMedicines.current;
      for (const { row, result: converted } of included) {
        if (row.medicineId) continue;
        const name = row.description.trim();
        const nameKey = name.toLowerCase();
        if (created.has(nameKey) || !converted) continue;
        const perPack = number(row.unitsPerPack) ?? 1;
        const response = await apiFetch<{ id: string; name: string; unit: string; manufacturer: string; packSize: string }>(
          "/api/medicines",
          {
            method: "POST",
            json: {
              name,
              packSize: row.pack.trim(),
              unit: row.unit || "unit",
              unitsPerStrip: canSellLoose(row.unit) && perPack > 1 ? perPack : "",
              defaultCostPrice: converted.costPrice,
              defaultSalePrice: converted.salePrice,
              vatExempt: row.vatExempt,
            },
          },
        );
        if (!response.ok) {
          setError(`Could not add "${name}" to the catalogue: ${response.message}`);
          return;
        }
        created.set(nameKey, {
          id: response.data.id,
          name: response.data.name,
          unit: response.data.unit,
          manufacturer: response.data.manufacturer,
          packSize: response.data.packSize,
          unitsPerStrip: perPack,
          lastCostPrice: converted.costPrice,
          lastSalePrice: converted.salePrice,
        });
      }

      onApply({
        lines: included.map(({ row, result: converted }) => ({
          medicineId: row.medicineId || created.get(row.description.trim().toLowerCase())!.id,
          batchNumber: row.batch.trim().toUpperCase(),
          expiryDate: expiryToDate(tidyExpiry(row.expiry)),
          quantity: converted!.quantity,
          freeQuantity: converted!.freeQuantity,
          costPrice: converted!.costPrice,
          salePrice: converted!.salePrice,
        })),
        created: [...created.values()],
        invoiceNo: result.invoiceNo,
        invoiceDate: result.invoiceDate,
        supplierId: result.supplierId,
      });
    } finally {
      setApplying(false);
    }
  }

  const cell = "input h-8 px-2 py-1 text-xs";

  return (
    <div className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Import supplier bill</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            A photo of the bill, or the supplier&rsquo;s Excel or CSV file. Check every line before adding it.
          </p>
        </div>
        <button type="button" onClick={onClose} className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
          Close
        </button>
      </div>

      {error ? (
        <div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {!result ? (
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <label
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border border-dashed border-slate-300 p-4 hover:border-brand-400 hover:bg-brand-50 ${reading ? "pointer-events-none opacity-60" : ""}`}
          >
            <span className="text-sm font-semibold text-slate-900">Photo of the bill</span>
            <span className="text-xs text-slate-500">
              Flat, close and in good light, the whole table in view. Use the original photo, not a WhatsApp copy. Reading can take up to 30 seconds.
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={reading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void read(file, "photo");
              }}
            />
          </label>
          <label
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border border-dashed border-slate-300 p-4 hover:border-brand-400 hover:bg-brand-50 ${reading ? "pointer-events-none opacity-60" : ""}`}
          >
            <span className="text-sm font-semibold text-slate-900">Excel or CSV file</span>
            <span className="text-xs text-slate-500">
              Columns such as Description, Pack, Batch, Expiry, Qty, Free, Rate, Amount, MRP - in any order.
            </span>
            <input
              type="file"
              accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="sr-only"
              disabled={reading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void read(file, "sheet");
              }}
            />
          </label>
          {reading ? (
            <p className="text-sm text-slate-600 sm:col-span-2" role="status">
              Reading the bill…
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="space-y-1 border-b border-slate-200 px-4 py-3 text-xs text-slate-600">
            <p>
              <span className="font-semibold text-slate-900">{rows.length}</span> line{rows.length === 1 ? "" : "s"} read
              {result.source === "photo" ? " from the photo" : " from the file"}
              {result.invoiceNo ? ` · invoice ${result.invoiceNo}` : ""}
              {result.invoiceDate ? ` · dated ${result.invoiceDate}` : ""}.
              {newNames.size > 0
                ? ` ${newNames.size} medicine${newNames.size === 1 ? " is" : "s are"} not in the catalogue yet and will be added.`
                : ""}
            </p>
            {result.note ? <p className="text-amber-700">{result.note}</p> : null}
            {result.source === "photo" ? (
              <p>
                Prices are checked against each other, but names, batch numbers and expiry dates
                cannot be. Compare those with the paper bill.
              </p>
            ) : null}
            <p>
              Quantities and prices are per pack, as on the bill; the purchase stores pieces. Set{" "}
              <span className="font-medium">Pcs/pack</span> to how many tablets or capsules one billed pack holds.
            </p>
          </div>

          <datalist id="bill-import-forms">
            {FORMS.map((form) => (
              <option key={form} value={form} />
            ))}
          </datalist>
          <div className="overflow-x-auto">
            <table className="min-w-[1180px] w-full text-left text-xs">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Add</th>
                  <th className="px-2 py-2">Medicine name</th>
                  <th className="px-2 py-2">Form</th>
                  <th className="px-2 py-2">Pack</th>
                  <th className="px-2 py-2">Batch</th>
                  <th className="px-2 py-2">Expiry</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Free</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2 text-right">MRP</th>
                  <th className="px-2 py-2 text-right">Pcs/pack</th>
                  <th className="px-2 py-2">Becomes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {checked.map(({ row, problems, result: converted }) => {
                  const sums = lineAddsUp({
                    quantity: number(row.quantity),
                    rate: number(row.rate),
                    amount: number(row.amount),
                  });
                  const off = !sums && number(row.amount) != null;
                  return (
                    <tr key={row.key} className={row.include ? "" : "opacity-50"}>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="checkbox"
                          checked={row.include}
                          onChange={(event) => update(row.key, { include: event.target.checked })}
                          aria-label={`Add ${row.description}`}
                          className="mt-2"
                        />
                      </td>
                      <td className="w-64 px-2 py-1.5 align-top">
                        {row.medicineId ? (
                          <>
                            <p className="flex h-8 items-center truncate text-xs font-medium text-slate-900">
                              {medicineById.get(row.medicineId)?.name ?? row.description}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              In your catalogue · bill says &ldquo;{row.description}&rdquo;
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                update(row.key, {
                                  medicineId: "",
                                  unitsPerPack: String(unitsPerPack(row.pack, row.unit || "unit")),
                                })
                              }
                              className="text-[11px] text-slate-500 underline"
                            >
                              Not this one - add as a new medicine
                            </button>
                          </>
                        ) : (
                          <>
                            <input
                              value={row.description}
                              onChange={(event) => update(row.key, { description: event.target.value })}
                              className={cell}
                              aria-label="Medicine name"
                            />
                            <p className="mt-0.5 text-[11px] text-brand-700">
                              New - added to the catalogue with this name
                            </p>
                            <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-600">
                              <input
                                type="checkbox"
                                checked={row.vatExempt}
                                onChange={(event) => update(row.key, { vatExempt: event.target.checked })}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                              />
                              VAT exempt (untick for soap, cosmetics and other items that carry VAT)
                            </label>
                            <Combobox
                              mode="select"
                              value=""
                              onChange={(value) => chooseMedicine(row.key, value)}
                              options={medicineOptions}
                              placeholder="…or link to an existing medicine"
                              ariaLabel={`Existing medicine for ${row.description}`}
                              className="mt-1"
                              inputClassName="h-7 text-[11px]"
                            />
                          </>
                        )}
                      </td>
                      <td className="w-28 px-2 py-1.5 align-top">
                        {row.medicineId ? (
                          <p className="flex h-8 items-center text-xs capitalize text-slate-700">
                            {medicineById.get(row.medicineId)?.unit ?? row.unit}
                          </p>
                        ) : (
                          <input
                            value={row.unit}
                            onChange={(event) => updateShape(row, { unit: event.target.value.toLowerCase() })}
                            list="bill-import-forms"
                            className={`${cell} capitalize`}
                            aria-label="Form"
                          />
                        )}
                      </td>
                      <td className="w-20 px-2 py-1.5 align-top">
                        <input
                          value={row.pack}
                          onChange={(event) =>
                            row.medicineId
                              ? update(row.key, { pack: event.target.value })
                              : updateShape(row, { pack: event.target.value })
                          }
                          className={cell}
                          aria-label="Pack"
                        />
                      </td>
                      <td className="w-28 px-2 py-1.5 align-top">
                        <input
                          value={row.batch}
                          onChange={(event) => update(row.key, { batch: event.target.value })}
                          className={`${cell} ${row.batch.trim() ? "" : "border-rose-300"}`}
                          aria-label="Batch"
                        />
                      </td>
                      <td className="w-24 px-2 py-1.5 align-top">
                        <input
                          value={row.expiry}
                          onChange={(event) => update(row.key, { expiry: event.target.value })}
                          onBlur={() => update(row.key, { expiry: tidyExpiry(row.expiry) || row.expiry })}
                          placeholder="MM/YYYY"
                          className={`${cell} ${expiryToDate(tidyExpiry(row.expiry)) ? "" : "border-rose-300"}`}
                          aria-label="Expiry"
                        />
                      </td>
                      {(["quantity", "free", "rate", "amount", "mrp"] as const).map((field) => (
                        <td key={field} className="w-20 px-2 py-1.5 align-top">
                          <input
                            value={row[field]}
                            onChange={(event) => update(row.key, { [field]: event.target.value })}
                            inputMode="decimal"
                            className={`${cell} tnum text-right ${
                              (field === "amount" || field === "quantity" || field === "rate") && off ? "border-amber-400 bg-amber-50" : ""
                            } ${field === "mrp" && !row.mrp ? "border-rose-300" : ""}`}
                            aria-label={field}
                          />
                        </td>
                      ))}
                      <td className="w-16 px-2 py-1.5 align-top">
                        <input
                          value={row.unitsPerPack}
                          onChange={(event) => update(row.key, { unitsPerPack: event.target.value })}
                          inputMode="numeric"
                          className={`${cell} tnum text-right`}
                          aria-label="Pieces per pack"
                        />
                      </td>
                      <td className="w-56 px-2 py-1.5 align-top text-[11px] leading-snug">
                        {problems.length > 0 ? (
                          <span className="text-rose-700">{problems.join(" ")}</span>
                        ) : converted ? (
                          <span className="text-slate-600">
                            {converted.quantity}
                            {converted.freeQuantity ? ` + ${converted.freeQuantity} free` : ""} pcs at{" "}
                            {money(converted.costPrice)}, MRP {money(converted.salePrice)} each
                            {converted.explanation ? <span className="block text-slate-500">{converted.explanation}</span> : null}
                          </span>
                        ) : null}
                        {off ? (
                          <span className="block text-amber-700">Qty × rate ≠ amount - check these.</span>
                        ) : !row.read && problems.length === 0 ? (
                          <span className="block text-amber-700">Not read with certainty - check against the bill.</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-600">
              {blocked > 0
                ? `${blocked} line${blocked === 1 ? " needs" : "s need"} fixing, or untick ${blocked === 1 ? "it" : "them"}.`
                : `${included.length} line${included.length === 1 ? "" : "s"} ready.`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setRows([]);
                }}
                className="btn-secondary px-3 py-1.5 text-xs"
              >
                Read another
              </button>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={applying || blocked > 0 || included.length === 0}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {applying ? "Adding…" : `Add ${included.length} line${included.length === 1 ? "" : "s"} to purchase`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
