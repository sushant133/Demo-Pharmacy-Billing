"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Field, SlideOver } from "@/components/SlideOver";
import { supplierSchema } from "@/lib/validation";

/** Add / edit a supplier, validated with the same schema the API enforces. */

export interface SupplierFormValues {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  panNo: string;
  paymentTermsDays: number;
  openingBalance: number;
  notes: string;
  isActive: boolean;
}

export function SupplierFormPanel({
  supplier,
  canDelete,
  returnTo = "/suppliers",
}: {
  supplier: SupplierFormValues | null;
  canDelete: boolean;
  returnTo?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(supplier);

  const [values, setValues] = useState({
    name: supplier?.name ?? "",
    contactPerson: supplier?.contactPerson ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    address: supplier?.address ?? "",
    panNo: supplier?.panNo ?? "",
    paymentTermsDays: String(supplier?.paymentTermsDays ?? 0),
    openingBalance: String(supplier?.openingBalance ?? 0),
    notes: supplier?.notes ?? "",
    isActive: supplier?.isActive ?? true,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = useCallback(() => {
    router.push(returnTo);
    router.refresh();
  }, [router, returnTo]);

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setFormError(null);

    const parsed = supplierSchema.safeParse(values);
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

    const result = await apiFetch(
      isEdit ? `/api/suppliers/${supplier!.id}` : "/api/suppliers",
      { method: isEdit ? "PATCH" : "POST", json: parsed.data },
    );

    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  async function remove() {
    if (!supplier) return;
    setSaving(true);
    setFormError(null);

    const result = await apiFetch(`/api/suppliers/${supplier.id}`, { method: "DELETE" });
    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }
    close();
  }

  return (
    <SlideOver
      title={isEdit ? "Edit supplier" : "Add supplier"}
      description={
        isEdit
          ? "Changes apply from now on; past purchases keep the details they were recorded with."
          : "Distributors you buy from. Every purchase belongs to one."
      }
      onClose={close}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add supplier"}
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

        <Field label="Supplier name" htmlFor="name" error={errors.name}>
          <input
            id="name"
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="e.g. Deurali-Janta Distributors"
            className="input"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact person" htmlFor="contactPerson" error={errors.contactPerson}>
            <input
              id="contactPerson"
              value={values.contactPerson}
              onChange={(event) => set("contactPerson", event.target.value)}
              className="input"
            />
          </Field>

          <Field label="Phone" htmlFor="phone" error={errors.phone}>
            <input
              id="phone"
              value={values.phone}
              onChange={(event) => set("phone", event.target.value)}
              placeholder="98…"
              className="input"
            />
          </Field>
        </div>

        <Field label="Email" htmlFor="email" error={errors.email}>
          <input
            id="email"
            type="email"
            value={values.email}
            onChange={(event) => set("email", event.target.value)}
            className="input"
          />
        </Field>

        <Field label="Address" htmlFor="address" error={errors.address}>
          <input
            id="address"
            value={values.address}
            onChange={(event) => set("address", event.target.value)}
            className="input"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="PAN / VAT no"
            htmlFor="panNo"
            error={errors.panNo}
            hint="Needed on the purchase register."
          >
            <input
              id="panNo"
              value={values.panNo}
              onChange={(event) => set("panNo", event.target.value)}
              className="input font-mono"
            />
          </Field>

          <Field
            label="Credit period (days)"
            htmlFor="paymentTermsDays"
            error={errors.paymentTermsDays}
            hint="Sets the due date on posting."
          >
            <input
              id="paymentTermsDays"
              type="number"
              min={0}
              value={values.paymentTermsDays}
              onChange={(event) => set("paymentTermsDays", event.target.value)}
              className="input tnum"
            />
          </Field>
        </div>

        <Field
          label="Opening balance (Rs)"
          htmlFor="openingBalance"
          error={errors.openingBalance}
          hint="What you already owed them before using this system."
        >
          <input
            id="openingBalance"
            type="number"
            step="0.01"
            value={values.openingBalance}
            onChange={(event) => set("openingBalance", event.target.value)}
            className="input tnum"
          />
        </Field>

        <Field label="Notes" htmlFor="notes" error={errors.notes}>
          <textarea
            id="notes"
            rows={2}
            value={values.notes}
            onChange={(event) => set("notes", event.target.value)}
            className="input resize-none"
          />
        </Field>

        {isEdit ? (
          <label className="flex items-center gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={values.isActive}
              onChange={(event) => set("isActive", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Active (inactive suppliers cannot be used on new purchases)
          </label>
        ) : null}

        {isEdit && canDelete ? (
          <div className="border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="text-xs font-medium text-rose-600 hover:text-rose-700 hover:underline"
            >
              Delete this supplier
            </button>
            <p className="mt-1 text-xs text-slate-500">
              If they have purchase or batch history they are marked inactive
              instead, so stock provenance stays intact.
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
