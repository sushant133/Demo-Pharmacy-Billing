"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { calculatePurchaseTotals, unitMargin } from "@/lib/purchase-math";
import { cx } from "@/components/ui";

/**
 * Purchase / GRN entry.
 *
 * This is the only way stock enters the shop, so the form is built for someone
 * typing a distributor's invoice with the delivery open in front of them:
 * a dense row per line, tab moving left to right in the order the invoice
 * prints, and running totals that update as they type.
 *
 * Totals are computed locally with the *same pure module the server uses*
 * (`lib/purchase-math.ts`), so the preview cannot disagree with what gets
 * saved. The server still recomputes on submit and remains the authority.
 */

export interface MedicineOption {
  id: string;
  name: string;
  unit: string;
  manufacturer: string;
}

export interface SupplierOption {
  id: string;
  name: string;
  paymentTermsDays: number;
}

interface LineState {
  key: string;
  medicineId: string;
  batchNumber: string;
  mfgDate: string;
  expiryDate: string;
  quantity: string;
  freeQuantity: string;
  costPrice: string;
  salePrice: string;
  discount: string;
}

export interface PurchaseFormValues {
  id: string;
  supplierId: string;
  invoiceNo: string;
  invoiceDate: string;
  receivedDate: string;
  discount: number;
  otherCharges: number;
  vatRate: number;
  notes: string;
  items: Array<{
    medicineId: string;
    batchNumber: string;
    mfgDate: string;
    expiryDate: string;
    quantity: number;
    freeQuantity: number;
    costPrice: number;
    salePrice: number;
    discount: number;
  }>;
}

let lineCounter = 0;
function blankLine(): LineState {
  lineCounter += 1;
  return {
    key: `line-${lineCounter}`,
    medicineId: "",
    batchNumber: "",
    mfgDate: "",
    expiryDate: "",
    quantity: "",
    freeQuantity: "",
    costPrice: "",
    salePrice: "",
    discount: "",
  };
}

const num = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function PurchaseForm({
  suppliers,
  medicines,
  defaultVatRate,
  today,
  purchase,
  canPost,
}: {
  suppliers: SupplierOption[];
  medicines: MedicineOption[];
  defaultVatRate: number;
  today: string;
  purchase: PurchaseFormValues | null;
  canPost: boolean;
}) {
  const router = useRouter();
  const isEdit = Boolean(purchase);

  const [supplierId, setSupplierId] = useState(purchase?.supplierId ?? "");
  const [invoiceNo, setInvoiceNo] = useState(purchase?.invoiceNo ?? "");
  const [invoiceDate, setInvoiceDate] = useState(purchase?.invoiceDate ?? "");
  const [receivedDate, setReceivedDate] = useState(purchase?.receivedDate ?? today);
  const [discount, setDiscount] = useState(String(purchase?.discount ?? 0));
  const [otherCharges, setOtherCharges] = useState(String(purchase?.otherCharges ?? 0));
  const [vatRate, setVatRate] = useState(String(purchase?.vatRate ?? defaultVatRate));
  const [notes, setNotes] = useState(purchase?.notes ?? "");

  const [lines, setLines] = useState<LineState[]>(() =>
    purchase && purchase.items.length > 0
      ? purchase.items.map((item) => {
          lineCounter += 1;
          return {
            key: `line-${lineCounter}`,
            medicineId: item.medicineId,
            batchNumber: item.batchNumber,
            mfgDate: item.mfgDate,
            expiryDate: item.expiryDate,
            quantity: String(item.quantity),
            freeQuantity: String(item.freeQuantity),
            costPrice: String(item.costPrice),
            salePrice: String(item.salePrice),
            discount: String(item.discount),
          };
        })
      : [blankLine()],
  );

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function addLine() {
    setLines((current) => [...current, blankLine()]);
  }

  function removeLine(key: string) {
    // Always leave one row, so the table never collapses to nothing.
    setLines((current) =>
      current.length === 1 ? [blankLine()] : current.filter((line) => line.key !== key),
    );
  }

  /** Lines complete enough to price. Incomplete rows are ignored until filled. */
  const pricedLines = useMemo(
    () =>
      lines.filter(
        (line) => line.medicineId && num(line.quantity) + num(line.freeQuantity) > 0,
      ),
    [lines],
  );

  const totals = useMemo(() => {
    if (pricedLines.length === 0) return null;
    try {
      return calculatePurchaseTotals({
        lines: pricedLines.map((line) => ({
          quantity: Math.trunc(num(line.quantity)),
          freeQuantity: Math.trunc(num(line.freeQuantity)),
          costPrice: num(line.costPrice),
          discount: num(line.discount),
        })),
        discount: num(discount),
        otherCharges: num(otherCharges),
        vatRate: num(vatRate),
      });
    } catch {
      // Mid-typing states are routinely invalid; the summary just waits.
      return null;
    }
  }, [pricedLines, discount, otherCharges, vatRate]);

  function payload() {
    return {
      supplierId,
      invoiceNo: invoiceNo.trim(),
      invoiceDate: invoiceDate || "",
      receivedDate,
      discount: num(discount),
      otherCharges: num(otherCharges),
      vatRate: num(vatRate),
      notes: notes.trim(),
      items: pricedLines.map((line) => ({
        medicineId: line.medicineId,
        batchNumber: line.batchNumber.trim(),
        mfgDate: line.mfgDate || "",
        expiryDate: line.expiryDate,
        quantity: Math.trunc(num(line.quantity)),
        freeQuantity: Math.trunc(num(line.freeQuantity)),
        costPrice: num(line.costPrice),
        salePrice: num(line.salePrice),
        discount: num(line.discount),
      })),
    };
  }

  async function submit(post: boolean) {
    setFormError(null);
    setErrors({});

    if (!supplierId) {
      setFormError("Choose the supplier this delivery came from.");
      return;
    }
    if (pricedLines.length === 0) {
      setFormError("Add at least one line with a medicine and a quantity.");
      return;
    }

    const incomplete = pricedLines.find(
      (line) => !line.batchNumber.trim() || !line.expiryDate,
    );
    if (incomplete) {
      setFormError(
        "Every line needs a batch number and an expiry date - they drive FEFO dispensing.",
      );
      return;
    }

    setSaving(true);

    const url = isEdit
      ? `/api/purchases/${purchase!.id}`
      : `/api/purchases${post ? "?post=1" : ""}`;

    const result = await apiFetch<{ id: string; grnNo: string }>(url, {
      method: isEdit ? "PATCH" : "POST",
      json: payload(),
    });

    if (!result.ok) {
      setFormError(result.message);
      // Surface per-field messages next to the field that caused them.
      const details = result.details as Record<string, string[]> | undefined;
      if (details) {
        const flat: Record<string, string> = {};
        for (const [path, messages] of Object.entries(details)) {
          if (messages[0]) flat[path] = messages[0];
        }
        setErrors(flat);
      }
      setSaving(false);
      return;
    }

    // Editing a draft then posting it is two calls: save, then post.
    if (isEdit && post) {
      const posted = await apiFetch(`/api/purchases/${purchase!.id}/post`, {
        method: "POST",
      });
      if (!posted.ok) {
        setFormError(posted.message);
        setSaving(false);
        return;
      }
    }

    router.push(`/purchases/${result.data.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {formError ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          {formError}
        </div>
      ) : null}

      {/* Invoice header */}
      <div className="card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="supplierId" className="label">
              Supplier
            </label>
            <select
              id="supplierId"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className="input"
              required
            >
              <option value="">Select a supplier…</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            {errors.supplierId ? (
              <p className="mt-1 text-xs text-rose-600">{errors.supplierId}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor="invoiceNo" className="label">
              Supplier invoice no
            </label>
            <input
              id="invoiceNo"
              value={invoiceNo}
              onChange={(event) => setInvoiceNo(event.target.value)}
              placeholder="As printed on their bill"
              className="input"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="invoiceDate" className="label">
                Invoice date
              </label>
              <input
                id="invoiceDate"
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
                className="input"
              />
            </div>
            <div>
              <label htmlFor="receivedDate" className="label">
                Received
              </label>
              <input
                id="receivedDate"
                type="date"
                value={receivedDate}
                onChange={(event) => setReceivedDate(event.target.value)}
                className="input"
                required
              />
            </div>
          </div>
        </div>
      </div>

      {/* Line items */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Items
            <span className="ml-2 font-normal text-slate-500">
              {pricedLines.length} of {lines.length} complete
            </span>
          </h2>
          <button type="button" onClick={addLine} className="btn-secondary px-3 py-1.5 text-xs">
            + Add line
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th w-[22%]">Medicine</th>
                <th className="th">Batch no</th>
                <th className="th">Mfg</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Free</th>
                <th className="th text-right">Cost</th>
                <th className="th text-right">Disc</th>
                <th className="th text-right">MRP</th>
                <th className="th text-right">Line</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, index) => {
                const quantity = Math.trunc(num(line.quantity));
                const free = Math.trunc(num(line.freeQuantity));
                const received = quantity + free;
                const net = Math.max(
                  0,
                  quantity * num(line.costPrice) - num(line.discount),
                );
                const effectiveCost = received > 0 ? net / received : 0;
                const margin =
                  num(line.salePrice) > 0 && effectiveCost > 0
                    ? unitMargin(effectiveCost, num(line.salePrice))
                    : null;

                return (
                  <tr key={line.key} className="align-top hover:bg-slate-50/60">
                    <td className="px-2 py-2">
                      <select
                        aria-label={`Medicine for line ${index + 1}`}
                        value={line.medicineId}
                        onChange={(event) =>
                          updateLine(line.key, { medicineId: event.target.value })
                        }
                        className="input py-1.5 text-xs"
                      >
                        <option value="">Select…</option>
                        {medicines.map((medicine) => (
                          <option key={medicine.id} value={medicine.id}>
                            {medicine.name}
                          </option>
                        ))}
                      </select>
                      {errors[`items.${index}.medicineId`] ? (
                        <p className="mt-1 text-[11px] text-rose-600">
                          {errors[`items.${index}.medicineId`]}
                        </p>
                      ) : null}
                    </td>

                    <td className="px-2 py-2">
                      <input
                        aria-label={`Batch number for line ${index + 1}`}
                        value={line.batchNumber}
                        onChange={(event) =>
                          updateLine(line.key, { batchNumber: event.target.value })
                        }
                        className="input py-1.5 font-mono text-xs"
                        placeholder="B2409A"
                      />
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="date"
                        aria-label={`Manufacturing date for line ${index + 1}`}
                        value={line.mfgDate}
                        onChange={(event) =>
                          updateLine(line.key, { mfgDate: event.target.value })
                        }
                        className="input py-1.5 text-xs"
                      />
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="date"
                        aria-label={`Expiry date for line ${index + 1}`}
                        value={line.expiryDate}
                        onChange={(event) =>
                          updateLine(line.key, { expiryDate: event.target.value })
                        }
                        className={cx(
                          "input py-1.5 text-xs",
                          errors[`items.${index}.expiryDate`] && "border-rose-400",
                        )}
                      />
                      {errors[`items.${index}.expiryDate`] ? (
                        <p className="mt-1 text-[11px] text-rose-600">
                          {errors[`items.${index}.expiryDate`]}
                        </p>
                      ) : null}
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        aria-label={`Quantity for line ${index + 1}`}
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(line.key, { quantity: event.target.value })
                        }
                        className="input tnum w-20 py-1.5 text-right text-xs"
                      />
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        aria-label={`Free quantity for line ${index + 1}`}
                        value={line.freeQuantity}
                        onChange={(event) =>
                          updateLine(line.key, { freeQuantity: event.target.value })
                        }
                        placeholder="0"
                        className="input tnum w-16 py-1.5 text-right text-xs"
                      />
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Cost price for line ${index + 1}`}
                        value={line.costPrice}
                        onChange={(event) =>
                          updateLine(line.key, { costPrice: event.target.value })
                        }
                        className="input tnum w-24 py-1.5 text-right text-xs"
                      />
                      {free > 0 && effectiveCost > 0 ? (
                        <p className="mt-1 text-right text-[11px] text-brand-700">
                          eff {effectiveCost.toFixed(2)}
                        </p>
                      ) : null}
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Discount for line ${index + 1}`}
                        value={line.discount}
                        onChange={(event) =>
                          updateLine(line.key, { discount: event.target.value })
                        }
                        placeholder="0"
                        className="input tnum w-20 py-1.5 text-right text-xs"
                      />
                    </td>

                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Sale price for line ${index + 1}`}
                        value={line.salePrice}
                        onChange={(event) =>
                          updateLine(line.key, { salePrice: event.target.value })
                        }
                        className="input tnum w-24 py-1.5 text-right text-xs"
                      />
                      {margin ? (
                        <p
                          className={cx(
                            "mt-1 text-right text-[11px]",
                            margin.perUnit < 0 ? "text-rose-600" : "text-slate-500",
                          )}
                        >
                          {margin.percent.toFixed(0)}%
                        </p>
                      ) : null}
                    </td>

                    <td className="tnum px-2 py-2 text-right text-sm font-medium text-slate-900">
                      {received > 0 ? money(net) : "—"}
                      {received > 0 ? (
                        <p className="text-[11px] font-normal text-slate-400">
                          {received} units
                        </p>
                      ) : null}
                    </td>

                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        aria-label={`Remove line ${index + 1}`}
                        className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
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

      {/* Charges + totals */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-4 lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="discount" className="label">
                Invoice discount (Rs)
              </label>
              <input
                id="discount"
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                className="input tnum"
              />
            </div>
            <div>
              <label htmlFor="otherCharges" className="label">
                Freight / other (Rs)
              </label>
              <input
                id="otherCharges"
                type="number"
                min={0}
                step="0.01"
                value={otherCharges}
                onChange={(event) => setOtherCharges(event.target.value)}
                className="input tnum"
              />
            </div>
            <div>
              <label htmlFor="vatRate" className="label">
                VAT rate
              </label>
              <select
                id="vatRate"
                value={vatRate}
                onChange={(event) => setVatRate(event.target.value)}
                className="input"
              >
                <option value="0">No VAT (0%)</option>
                <option value="0.13">Standard (13%)</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="notes" className="label">
              Notes
            </label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Anything worth remembering about this delivery…"
              className="input resize-none"
            />
          </div>
        </div>

        <div className="card divide-y divide-slate-100">
          <div className="space-y-2 p-4">
            <Row label="Subtotal" value={totals ? money(totals.subtotal) : "—"} />
            {totals && totals.discount > 0 ? (
              <Row
                label="Discount"
                value={`− ${money(totals.discount)}`}
                className="text-rose-600"
              />
            ) : null}
            {totals && totals.otherCharges > 0 ? (
              <Row label="Other charges" value={money(totals.otherCharges)} />
            ) : null}
            <Row
              label={`VAT (${totals ? Math.round(totals.vatRate * 100) : 0}%)`}
              value={totals ? money(totals.vatAmount) : "—"}
            />
            <div className="flex items-baseline justify-between border-t border-slate-200 pt-3">
              <span className="text-sm font-medium text-slate-900">Total</span>
              <span className="tnum text-2xl font-bold text-slate-900">
                {totals ? money(totals.totalAmount) : money(0)}
              </span>
            </div>
            {totals ? (
              <p className="text-right text-xs text-slate-500">
                {totals.totalUnits} units onto the shelf
              </p>
            ) : null}
          </div>

          <div className="space-y-2 p-4">
            {canPost ? (
              <button
                type="button"
                onClick={() => submit(true)}
                disabled={saving || !totals}
                className="btn-primary w-full py-2.5"
              >
                {saving ? "Working…" : "Receive & post"}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => submit(false)}
              disabled={saving || !totals}
              className="btn-secondary w-full"
            >
              {isEdit ? "Save draft" : "Save as draft"}
            </button>

            <p className="pt-1 text-center text-[11px] leading-relaxed text-slate-400">
              Posting creates the stock and cannot be edited afterwards. A draft
              changes nothing on the shelf.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center justify-between text-sm", className)}>
      <span className="text-slate-600">{label}</span>
      <span className="tnum font-medium">{value}</span>
    </div>
  );
}
