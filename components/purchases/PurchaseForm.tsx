"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import {
  describePurchaseQuantity,
  formatUnitCount,
  stripLabel,
  unitWord,
} from "@/lib/pack";
import { calculatePurchaseTotals, round2, unitMargin } from "@/lib/purchase-math";
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
} from "@/lib/constants";
import { Combobox, type ComboOption } from "@/components/Combobox";
import { DualDateField } from "@/components/DualDateField";
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
  genericName?: string;
  packSize?: string;
  unitsPerStrip?: number;
  lastCostPrice?: number | null;
  lastSalePrice?: number | null;
}

export interface StockPreset {
  medicineId: string;
  medicineName: string;
  manufacturer?: string;
  genericName?: string;
  packSize?: string;
  unit?: string;
  unitsPerStrip?: number;
  lastCostPrice?: number | null;
  lastSalePrice?: number | null;
  lastSupplierId?: string | null;
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
  applySalePriceToStock: boolean;
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
    applySalePriceToStock?: boolean;
  }>;
}

// Only lines added after the first render draw from the counter. The lines the
// form opens with take fixed keys, because the counter is module state: it
// has a different value on the server than in the browser, and the keys feed
// input ids that must match between the two renders.
let lineCounter = 0;
function blankLine(key?: string): LineState {
  if (!key) lineCounter += 1;
  return {
    key: key ?? `line-${lineCounter}`,
    medicineId: "",
    batchNumber: "",
    mfgDate: "",
    expiryDate: "",
    quantity: "",
    freeQuantity: "",
    costPrice: "",
    salePrice: "",
    discount: "",
    applySalePriceToStock: false,
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
  expiryAlertDays,
  today,
  purchase,
  canPost,
  preset,
}: {
  suppliers: SupplierOption[];
  medicines: MedicineOption[];
  defaultVatRate: number;
  /** Shelf-life floor from settings; lots under it get a short-dated warning. */
  expiryAlertDays: number;
  today: string;
  purchase: PurchaseFormValues | null;
  canPost: boolean;
  preset?: StockPreset | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(purchase);
  // A new delivery has no GRN yet - the server allocates it on save.
  const grnLabel = purchase ? `GRN ${purchase.id.slice(-6).toUpperCase()}` : "this delivery";
  const medicineById = useMemo(
    () => new Map(medicines.map((medicine) => [medicine.id, medicine])),
    [medicines],
  );
  // Searchable by name, generic name and manufacturer; the second line tells
  // two strengths or two makers of the same drug apart.
  const medicineOptions = useMemo<ComboOption[]>(
    () =>
      medicines.map((medicine) => ({
        value: medicine.id,
        label: medicine.name,
        detail:
          [medicine.manufacturer, medicine.packSize, medicine.unit].filter(Boolean).join(" · ") ||
          undefined,
        keywords: medicine.genericName,
      })),
    [medicines],
  );
  const supplierOptions = useMemo<ComboOption[]>(
    () =>
      suppliers.map((supplier) => ({
        value: supplier.id,
        label: supplier.name,
        detail:
          supplier.paymentTermsDays > 0 ? `${supplier.paymentTermsDays}-day credit` : "Cash terms",
      })),
    [suppliers],
  );

  const [supplierId, setSupplierId] = useState(
    purchase?.supplierId ??
      (preset?.lastSupplierId && suppliers.some((s) => s.id === preset.lastSupplierId)
        ? preset.lastSupplierId
        : ""),
  );
  const [invoiceNo, setInvoiceNo] = useState(purchase?.invoiceNo ?? "");
  const [invoiceDate, setInvoiceDate] = useState(purchase?.invoiceDate ?? "");
  const [receivedDate, setReceivedDate] = useState(purchase?.receivedDate ?? today);
  const [discount, setDiscount] = useState(String(purchase?.discount ?? 0));
  const [otherCharges, setOtherCharges] = useState(String(purchase?.otherCharges ?? 0));
  const [vatRate, setVatRate] = useState(String(purchase?.vatRate ?? defaultVatRate));
  const [notes, setNotes] = useState(purchase?.notes ?? "");

  // Payment taken at the door, and the term for whatever is left.
  const [paidAmount, setPaidAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string>("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [creditDays, setCreditDays] = useState("");
  const [confirming, setConfirming] = useState(false);

  const [lines, setLines] = useState<LineState[]>(() => {
    if (purchase && purchase.items.length > 0) {
      return purchase.items.map((item, index) => {
        return {
          key: `initial-${index}`,
          medicineId: item.medicineId,
          batchNumber: item.batchNumber,
          mfgDate: item.mfgDate,
          expiryDate: item.expiryDate,
          quantity: String(item.quantity),
          freeQuantity: String(item.freeQuantity),
          costPrice: String(item.costPrice),
          salePrice: String(item.salePrice),
          discount: String(item.discount),
          applySalePriceToStock: Boolean(item.applySalePriceToStock),
        };
      });
    }
    if (preset?.medicineId) {
      return [
        {
          key: "initial-0",
          medicineId: preset.medicineId,
          batchNumber: "",
          mfgDate: "",
          expiryDate: "",
          quantity: "",
          freeQuantity: "",
          costPrice:
            preset.lastCostPrice != null ? String(preset.lastCostPrice) : "",
          salePrice:
            preset.lastSalePrice != null ? String(preset.lastSalePrice) : "",
          discount: "",
          applySalePriceToStock: false,
        },
      ];
    }
    return [blankLine("initial-0")];
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inflight = useRef(false);

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function selectMedicine(key: string, medicineId: string) {
    const hint = medicineById.get(medicineId);
    updateLine(key, {
      medicineId,
      costPrice:
        hint?.lastCostPrice != null ? String(hint.lastCostPrice) : "",
      salePrice:
        hint?.lastSalePrice != null ? String(hint.lastSalePrice) : "",
      applySalePriceToStock: false,
    });
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

  const paidNow = Math.max(0, num(paidAmount));
  const dueAfter = round2((totals?.totalAmount ?? 0) - paidNow);
  const overpaid = Boolean(totals) && paidNow > (totals?.totalAmount ?? 0) + 0.001;

  /**
   * Lots arriving with less shelf life than the shop's expiry alert window.
   *
   * A warning, never a block. Short-dated stock is routinely accepted - often
   * at a discount, and knowingly - so refusing it would send people around the
   * system rather than through it. What it must not do is arrive unremarked
   * and surface three months later as dead stock nobody chose to buy.
   */
  const shortDated = pricedLines.filter((line) => {
    if (!line.expiryDate) return false;
    const days = Math.floor(
      (new Date(line.expiryDate).getTime() - Date.now()) / 86_400_000,
    );
    return days <= expiryAlertDays;
  });

  function payload() {
    return {
      supplierId,
      invoiceNo: invoiceNo.trim(),
      invoiceDate: invoiceDate || "",
      receivedDate,
      discount: num(discount),
      otherCharges: num(otherCharges),
      vatRate: num(vatRate),
      creditDays: creditDays.trim() === "" ? "" : Math.trunc(num(creditDays)),
      // Only sent when money actually changed hands, and only ever applied on
      // posting - the server ignores it on a draft.
      ...(paidNow > 0
        ? {
            payment: {
              amount: paidNow,
              method: paymentMethod,
              reference: paymentReference.trim(),
            },
          }
        : {}),
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
        applySalePriceToStock: line.applySalePriceToStock,
      })),
    };
  }

  async function submit(post: boolean) {
    if (inflight.current) return;
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

    inflight.current = true;
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
      // Back to the form rather than stuck on a confirmation the server refused.
      setConfirming(false);
      // Surface per-field messages next to the field that caused them.
      const details = result.details as Record<string, string[]> | undefined;
      if (details) {
        const flat: Record<string, string> = {};
        for (const [path, messages] of Object.entries(details)) {
          if (messages[0]) flat[path] = messages[0];
        }
        setErrors(flat);
      }
      inflight.current = false;
      setSaving(false);
      return;
    }

    // Editing a draft then posting it is two calls: save, then post.
    if (isEdit && post) {
      const posted = await apiFetch(`/api/purchases/${purchase!.id}/post`, {
        method: "POST",
      });
      if (!posted.ok) {
        inflight.current = false;
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="supplierId" className="label">
              Supplier
            </label>
            <Combobox
              id="supplierId"
              mode="select"
              value={supplierId}
              onChange={setSupplierId}
              options={supplierOptions}
              placeholder="Search suppliers…"
              invalid={Boolean(errors.supplierId)}
              emptyText="No supplier matches. Add them under Suppliers first."
            />
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

          <div className="min-w-0">
            <p className="label">Invoice date</p>
            <DualDateField
              id="invoiceDate"
              value={invoiceDate}
              onChange={setInvoiceDate}
              compact
              aria-label="Invoice date"
            />
          </div>
          <div className="min-w-0">
            <p className="label">Received</p>
            <DualDateField
              id="receivedDate"
              value={receivedDate}
              onChange={setReceivedDate}
              required
              compact
              aria-label="Received date"
            />
          </div>
        </div>
      </div>

      {/* Line items */}
      <div className="card">
        {preset && !isEdit ? (
          <div className="border-b border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-900">
            <p>
              Receiving stock for{" "}
              <span className="font-semibold">{preset.medicineName}</span>
              {preset.packSize ? ` (${preset.packSize})` : ""}
              {preset.manufacturer ? ` · ${preset.manufacturer}` : ""}
              {preset.genericName ? ` · ${preset.genericName}` : ""}.
            </p>
            {stripLabel(preset.unitsPerStrip ?? 1, preset.unit ?? "tablet") ? (
              <p className="mt-1 text-xs text-brand-800">
                Count {unitWord(preset.unit ?? "tablet", 2)}, not strips. One{" "}
                {stripLabel(preset.unitsPerStrip ?? 1, preset.unit ?? "tablet")} is
                quantity {preset.unitsPerStrip}.
              </p>
            ) : null}
            <p className="mt-1 text-xs text-brand-800">
              {preset.lastCostPrice != null ? (
                <>Last cost {money(preset.lastCostPrice)}. </>
              ) : null}
              {preset.lastSalePrice != null ? (
                <>
                  Last selling price {money(preset.lastSalePrice)} — change MRP
                  if this lot has a new price.
                </>
              ) : (
                <>Fill the batch, expiry, quantity and prices for this delivery.</>
              )}
            </p>
          </div>
        ) : null}
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

        {/*
          One card per invoice line rather than an eleven-column grid: the
          medicine's full name sits on its own row and is never cut off, the
          fields follow in the order the distributor's bill prints them, and
          every line spells out its own arithmetic.
        */}
        <ol className="divide-y divide-slate-100">
          {lines.map((line, index) => {
            const medicine = medicineById.get(line.medicineId);
            const unit = medicine?.unit ?? "unit";
            const quantity = Math.trunc(num(line.quantity));
            const free = Math.trunc(num(line.freeQuantity));
            const received = quantity + free;
            const cost = num(line.costPrice);
            const lineDiscount = num(line.discount);
            const gross = quantity * cost;
            const net = Math.max(0, gross - lineDiscount);
            const effectiveCost = received > 0 ? net / received : 0;
            const margin =
              num(line.salePrice) > 0 && effectiveCost > 0
                ? unitMargin(effectiveCost, num(line.salePrice))
                : null;
            const quantityHint = describePurchaseQuantity(
              quantity,
              medicine?.unitsPerStrip ?? 1,
              unit,
            );
            const lastSale = medicine?.lastSalePrice ?? null;
            const typedSale = num(line.salePrice);
            const fieldError = (field: string) => errors[`items.${index}.${field}`];
            const n = index + 1;
            const medicineMeta = medicine
              ? [medicine.genericName, medicine.manufacturer, medicine.packSize].filter(Boolean)
              : [];

            return (
              <li key={line.key} className="p-4">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-6 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700"
                  >
                    {n}
                  </span>
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`${line.key}-medicine`} className="label">
                      Medicine
                    </label>
                    <Combobox
                      id={`${line.key}-medicine`}
                      mode="select"
                      value={line.medicineId}
                      onChange={(medicineId) => selectMedicine(line.key, medicineId)}
                      options={medicineOptions}
                      ariaLabel={`Medicine for line ${n}`}
                      placeholder="Search by name, generic name or manufacturer…"
                      invalid={Boolean(fieldError("medicineId"))}
                      emptyText="No medicine matches. Add it under Medicines first."
                    />
                    {medicine ? (
                      <p className="mt-1 break-words text-xs text-slate-500">
                        {[...medicineMeta, `counted in ${unitWord(unit, 2)}`].join(" · ")}
                      </p>
                    ) : null}
                    {fieldError("medicineId") ? (
                      <p className="mt-1 text-[11px] text-rose-600">{fieldError("medicineId")}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    aria-label={`Remove line ${n}`}
                    title="Remove this line"
                    className="mt-6 shrink-0 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:pl-9">
                  <div>
                    <label htmlFor={`${line.key}-batch`} className="label">
                      Batch no
                    </label>
                    <input
                      id={`${line.key}-batch`}
                      value={line.batchNumber}
                      onChange={(event) =>
                        updateLine(line.key, { batchNumber: event.target.value })
                      }
                      className="input font-mono"
                      placeholder="B2409A"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="label">Mfg date</p>
                    <DualDateField
                      id={`${line.key}-mfg`}
                      value={line.mfgDate}
                      onChange={(next) => updateLine(line.key, { mfgDate: next })}
                      compact
                      aria-label={`Manufacturing date for line ${n}`}
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="label">Expiry date</p>
                    <DualDateField
                      id={`${line.key}-exp`}
                      value={line.expiryDate}
                      onChange={(next) => updateLine(line.key, { expiryDate: next })}
                      compact
                      error={Boolean(fieldError("expiryDate"))}
                      aria-label={`Expiry date for line ${n}`}
                    />
                    {fieldError("expiryDate") ? (
                      <p className="mt-1 text-[11px] text-rose-600">{fieldError("expiryDate")}</p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:pl-9">
                  <div>
                    <label htmlFor={`${line.key}-qty`} className="label">
                      Quantity
                    </label>
                    <input
                      id={`${line.key}-qty`}
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                      placeholder="0"
                      className="input tnum text-right"
                    />
                    {quantityHint ? (
                      <p className="mt-1 text-[11px] leading-snug text-slate-500">{quantityHint}</p>
                    ) : null}
                  </div>
                  <div>
                    <label htmlFor={`${line.key}-free`} className="label">
                      Free
                    </label>
                    <input
                      id={`${line.key}-free`}
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={line.freeQuantity}
                      onChange={(event) =>
                        updateLine(line.key, { freeQuantity: event.target.value })
                      }
                      placeholder="0"
                      className="input tnum text-right"
                    />
                  </div>
                  <div>
                    <label htmlFor={`${line.key}-cost`} className="label">
                      Cost (Rs.)
                    </label>
                    <input
                      id={`${line.key}-cost`}
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={line.costPrice}
                      onChange={(event) => updateLine(line.key, { costPrice: event.target.value })}
                      placeholder="0.00"
                      className="input tnum text-right"
                    />
                    {free > 0 && effectiveCost > 0 ? (
                      <p className="mt-1 text-right text-[11px] text-brand-700">
                        Effective {money(effectiveCost)} each
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <label htmlFor={`${line.key}-disc`} className="label">
                      Discount (Rs.)
                    </label>
                    <input
                      id={`${line.key}-disc`}
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={line.discount}
                      onChange={(event) => updateLine(line.key, { discount: event.target.value })}
                      placeholder="0.00"
                      className="input tnum text-right"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor={`${line.key}-mrp`} className="label">
                      MRP (Rs.)
                    </label>
                    <input
                      id={`${line.key}-mrp`}
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={line.salePrice}
                      onChange={(event) => updateLine(line.key, { salePrice: event.target.value })}
                      placeholder="0.00"
                      className="input tnum text-right"
                    />
                    {margin ? (
                      <p
                        className={cx(
                          "mt-1 text-right text-[11px]",
                          margin.perUnit < 0 ? "text-rose-600" : "text-slate-500",
                        )}
                      >
                        {margin.percent.toFixed(0)}% margin
                      </p>
                    ) : null}
                    {lastSale != null && typedSale && typedSale !== lastSale ? (
                      <p className="mt-1 text-right text-[11px] text-amber-700">
                        was {money(lastSale)}
                      </p>
                    ) : null}
                  </div>
                </div>

                {line.medicineId ? (
                  <label className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-slate-500 sm:pl-9">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={line.applySalePriceToStock}
                      onChange={(event) =>
                        updateLine(line.key, { applySalePriceToStock: event.target.checked })
                      }
                    />
                    <span>Apply this MRP to current stock of this medicine</span>
                  </label>
                ) : null}

                {/* The line's arithmetic, spelled out: Rs. 100.00 × 5 = Rs. 500.00. */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 sm:ml-9">
                  <p className="tnum text-sm text-slate-600" aria-live="polite">
                    {quantity > 0 && cost > 0 ? (
                      <>
                        {money(cost)} × {quantity} ={" "}
                        <span className="font-semibold text-slate-900">{money(gross)}</span>
                        {lineDiscount > 0 ? (
                          <>
                            {" "}
                            − {money(lineDiscount)} discount ={" "}
                            <span className="font-semibold text-slate-900">{money(net)}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-slate-400">
                        Enter the cost and quantity to see this line&rsquo;s total.
                      </span>
                    )}
                  </p>
                  <p className="tnum text-right">
                    <span className="text-xs text-slate-500">Line total </span>
                    <span className="text-base font-semibold text-slate-900">
                      {received > 0 ? money(net) : "—"}
                    </span>
                    {received > 0 ? (
                      <span className="block text-[11px] text-slate-400">
                        {formatUnitCount(received, unit)} received
                        {free > 0 ? ` (${free} free)` : ""}
                      </span>
                    ) : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={addLine} className="btn-secondary w-full sm:w-auto">
            + Add another medicine
          </button>
        </div>
      </div>

      {/* Charges + totals */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-4 lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="discount" className="label">
                Invoice discount (Rs.)
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
                Freight / other (Rs.)
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
                {totals.totalUnits} pieces onto the shelf
              </p>
            ) : null}

            {/*
              Said before posting, not after. Short-dated stock is a legitimate
              purchase - often discounted and knowingly taken - so this warns
              and never blocks. What it prevents is a lot arriving unremarked
              and turning up months later as dead stock nobody chose to buy.
            */}
            {shortDated.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-medium text-amber-900">
                  {shortDated.length} lot{shortDated.length === 1 ? "" : "s"}{" "}
                  expire within {expiryAlertDays} days
                </p>
                <ul className="mt-1 space-y-0.5">
                  {shortDated.slice(0, 4).map((line) => (
                    <li key={line.key} className="text-[11px] text-amber-800">
                      {medicineById.get(line.medicineId)?.name ?? "Line"} ·{" "}
                      <span className="font-mono">{line.batchNumber}</span> · exp{" "}
                      {line.expiryDate}
                    </li>
                  ))}
                  {shortDated.length > 4 ? (
                    <li className="text-[11px] text-amber-800">
                      and {shortDated.length - 4} more.
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>

          {/*
            Payment, and only where it can mean anything.

            A draft is not yet a liability, so money cannot be paid against
            one - recording it would book cash leaving the shop for a delivery
            the system does not believe happened. The section therefore belongs
            to posting, and is hidden from a role that cannot post.
          */}
          {canPost ? (
            <div className="space-y-3 border-t border-slate-100 p-4">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                Payment
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="paidAmount" className="label">
                    Paid now
                  </label>
                  <input
                    id="paidAmount"
                    type="number"
                    min={0}
                    step="0.01"
                    value={paidAmount}
                    onChange={(event) => setPaidAmount(event.target.value)}
                    placeholder="0.00"
                    className="input tnum"
                  />
                </div>
                <div>
                  <label htmlFor="paymentMethod" className="label">
                    Method
                  </label>
                  <select
                    id="paymentMethod"
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value)}
                    disabled={paidNow <= 0}
                    className="input disabled:bg-slate-50 disabled:text-slate-400"
                  >
                    {SUPPLIER_PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {SUPPLIER_PAYMENT_METHOD_LABELS[method]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {paidNow > 0 ? (
                <div>
                  <label htmlFor="paymentReference" className="label">
                    Reference{" "}
                    <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <input
                    id="paymentReference"
                    value={paymentReference}
                    onChange={(event) => setPaymentReference(event.target.value)}
                    maxLength={120}
                    placeholder="Cheque no, transaction id"
                    className="input"
                  />
                </div>
              ) : null}

              <div>
                <label htmlFor="creditDays" className="label">
                  Credit days{" "}
                  <span className="font-normal text-slate-400">
                    (supplier default if blank)
                  </span>
                </label>
                <input
                  id="creditDays"
                  type="number"
                  min={0}
                  max={365}
                  value={creditDays}
                  onChange={(event) => setCreditDays(event.target.value)}
                  placeholder="Supplier terms"
                  className="input tnum"
                />
              </div>

              {/* What the shop will still owe once this posts. */}
              <div
                className={cx(
                  "rounded-lg px-3 py-2",
                  dueAfter <= 0 ? "bg-emerald-50" : "bg-amber-50",
                )}
              >
                <div className="flex items-center justify-between text-sm">
                  <span
                    className={
                      dueAfter <= 0 ? "text-emerald-800" : "text-amber-900"
                    }
                  >
                    {dueAfter <= 0 ? "Settled in full" : "Still owing"}
                  </span>
                  <span
                    className={cx(
                      "tnum font-semibold",
                      dueAfter <= 0 ? "text-emerald-700" : "text-amber-800",
                    )}
                  >
                    {money(Math.max(0, dueAfter))}
                  </span>
                </div>
              </div>

              {overpaid ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  That is more than this delivery comes to. Record the
                  difference as a separate on-account payment instead.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2 border-t border-slate-100 p-4">
            {/*
              Posting is the one irreversible step in this form: it creates
              batches, moves stock and books money. It gets a confirmation that
              states the consequence in units rather than a generic "are you
              sure", because the number worth checking is what lands on the
              shelf.
            */}
            {confirming ? (
              <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-3">
                <p className="text-sm font-medium text-slate-900">
                  Post {grnLabel} and add stock?
                </p>
                <ul className="mt-2 space-y-1 border-y border-brand-200/60 py-2 text-xs text-slate-700">
                  <li className="flex justify-between gap-3">
                    <span className="text-slate-500">Onto the shelf</span>
                    <span className="tnum font-medium">
                      {totals?.totalUnits ?? 0} pieces across{" "}
                      {pricedLines.length} lot
                      {pricedLines.length === 1 ? "" : "s"}
                    </span>
                  </li>
                  <li className="flex justify-between gap-3">
                    <span className="text-slate-500">Invoice total</span>
                    <span className="tnum font-medium">
                      {money(totals?.totalAmount ?? 0)}
                    </span>
                  </li>
                  <li className="flex justify-between gap-3">
                    <span className="text-slate-500">Paying now</span>
                    <span className="tnum font-medium">{money(paidNow)}</span>
                  </li>
                  <li className="flex justify-between gap-3">
                    <span className="text-slate-500">Left owing</span>
                    <span className="tnum font-medium">
                      {money(Math.max(0, dueAfter))}
                    </span>
                  </li>
                </ul>
                <p className="mt-2 text-[11px] text-slate-500">
                  A posted delivery cannot be edited. Correcting one means
                  cancelling it, which is only possible while none of it has
                  been sold.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={saving}
                    className="btn-secondary flex-1"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={saving}
                    className="btn-primary flex-[2]"
                  >
                    {saving ? "Posting…" : "Receive & post"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {canPost ? (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={saving || !totals || overpaid}
                    className="btn-primary w-full py-2.5"
                  >
                    Receive &amp; post
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
                  Posting adds the received quantity to inventory and cannot be
                  edited afterwards. A draft changes nothing on the shelf.
                </p>
              </>
            )}
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
