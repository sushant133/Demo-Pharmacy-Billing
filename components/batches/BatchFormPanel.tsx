"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { unitMargin } from "@/lib/purchase-math";
import { DualDateField } from "@/components/DualDateField";
import { Field, SlideOver } from "@/components/SlideOver";
import { batchUpdateSchema } from "@/lib/validation";

/**
 * Correct an existing batch.
 *
 * Since Phase 2 this panel can only *edit*. Stock enters the shop by posting a
 * purchase, which is what ties every lot to the delivery it arrived on, so
 * there is no "new batch" form any more. What remains are the genuine
 * after-the-fact corrections: a recount, breakage, or a price change.
 */

export interface BatchFormValues {
  id: string;
  medicineName: string;
  batchNumber: string;
  mfgDate: string;
  expiryDate: string;
  quantity: number;
  costPrice: number;
  salePrice: number;
  notes: string;
  grnNo: string;
}

export function BatchFormPanel({
  batch,
  canDelete,
}: {
  batch: BatchFormValues;
  canDelete: boolean;
}) {
  const router = useRouter();

  const [values, setValues] = useState({
    batchNumber: batch.batchNumber,
    mfgDate: batch.mfgDate,
    expiryDate: batch.expiryDate,
    quantity: String(batch.quantity),
    costPrice: String(batch.costPrice),
    salePrice: String(batch.salePrice),
    notes: batch.notes,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = useCallback(() => {
    router.push("/batches");
    router.refresh();
  }, [router]);

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const margin = useMemo(() => {
    const cost = Number(values.costPrice);
    const sale = Number(values.salePrice);
    if (!Number.isFinite(cost) || !Number.isFinite(sale) || cost <= 0 || sale <= 0) {
      return null;
    }
    return unitMargin(cost, sale);
  }, [values.costPrice, values.salePrice]);

  async function save() {
    setFormError(null);

    const parsed = batchUpdateSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});
    setSaving(true);

    const result = await apiFetch(`/api/batches/${batch.id}`, {
      method: "PATCH",
      json: parsed.data,
    });

    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  async function remove() {
    setSaving(true);
    setFormError(null);

    const result = await apiFetch(`/api/batches/${batch.id}`, { method: "DELETE" });
    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }
    close();
  }

  return (
    <SlideOver
      title="Correct batch"
      description={`${batch.medicineName} · lot ${batch.batchNumber}`}
      onClose={close}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Cancel
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {formError}
          </div>
        ) : null}

        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {batch.grnNo ? (
            <>
              Received on GRN{" "}
              <span className="font-mono font-medium text-slate-800">{batch.grnNo}</span>.
              Edits here are corrections and do not change that purchase record.
            </>
          ) : (
            "This lot predates purchase tracking, so it has no GRN linked."
          )}
        </div>

        <Field label="Batch number" htmlFor="batchNumber" error={errors.batchNumber}>
          <input
            id="batchNumber"
            value={values.batchNumber}
            onChange={(event) => set("batchNumber", event.target.value)}
            className="input font-mono"
            required
          />
        </Field>

        <Field label="Mfg date" htmlFor="mfgDate" error={errors.mfgDate}>
          <DualDateField
            id="mfgDate"
            value={values.mfgDate}
            onChange={(next) => set("mfgDate", next)}
            aria-label="Manufacturing date"
          />
        </Field>

        <Field
          label="Expiry date"
          htmlFor="expiryDate"
          error={errors.expiryDate}
          hint="English or Nepali — both are the same day. Drives FEFO order."
        >
          <DualDateField
            id="expiryDate"
            value={values.expiryDate}
            onChange={(next) => set("expiryDate", next)}
            required
            aria-label="Expiry date"
          />
        </Field>

        <Field
          label="Quantity on shelf"
          htmlFor="quantity"
          error={errors.quantity}
          hint="Sets the count outright — use for a recount or breakage."
        >
          <input
            id="quantity"
            type="number"
            min={0}
            step={1}
            value={values.quantity}
            onChange={(event) => set("quantity", event.target.value)}
            className="input tnum"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost price (Rs)" htmlFor="costPrice" error={errors.costPrice}>
            <input
              id="costPrice"
              type="number"
              min={0}
              step="0.01"
              value={values.costPrice}
              onChange={(event) => set("costPrice", event.target.value)}
              className="input tnum"
              required
            />
          </Field>

          <Field label="Sale price (Rs)" htmlFor="salePrice" error={errors.salePrice}>
            <input
              id="salePrice"
              type="number"
              min={0}
              step="0.01"
              value={values.salePrice}
              onChange={(event) => set("salePrice", event.target.value)}
              className="input tnum"
              required
            />
          </Field>
        </div>

        {margin ? (
          <div
            className={`rounded-lg px-3 py-2 text-xs ${
              margin.perUnit < 0 ? "bg-rose-50 text-rose-700" : "bg-slate-50 text-slate-600"
            }`}
          >
            Margin{" "}
            <strong className="tnum font-semibold">
              {money(margin.perUnit)} / unit ({margin.percent.toFixed(1)}%)
            </strong>
            {margin.perUnit < 0 ? " — selling below cost." : null}
          </div>
        ) : null}

        <Field label="Notes" htmlFor="notes" error={errors.notes}>
          <textarea
            id="notes"
            rows={2}
            value={values.notes}
            onChange={(event) => set("notes", event.target.value)}
            placeholder="Why was this corrected?"
            className="input resize-none"
          />
        </Field>

        {canDelete ? (
          <div className="border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="text-xs font-medium text-rose-600 hover:text-rose-700 hover:underline"
            >
              Delete this batch
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Refused if the batch appears on any bill — set its quantity to 0
              instead.
            </p>
          </div>
        ) : null}

        <button type="submit" className="sr-only">
          Save
        </button>
      </form>
    </SlideOver>
  );
}
