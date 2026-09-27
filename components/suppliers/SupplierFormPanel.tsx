"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Field, SlideOver } from "@/components/SlideOver";
import { supplierSchema } from "@/lib/validation";

/** Add / edit a supplier, validated with the same schema the API enforces. */

/** Keep only digits, capped at `max`. A pasted +977 country code is dropped. */
function digitsOnly(value: string, max: number): string {
  // A +977 country code in front (typed or pasted) is dropped once the full
  // number is there, which is when it can be told apart from the number.
  let digits = value.replace(/\D/g, "");
  if (max === 10 && digits.length > 10 && digits.startsWith("977")) digits = digits.slice(3);
  return digits.slice(0, max);
}

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
    // Fixing a field clears its message; blur checks it again.
    if (errors[key]) setErrors(({ [key]: _cleared, ...rest }) => rest);
  }

  /** Check one field against the API's own rule as soon as it is left. */
  function check(key: "phone" | "email" | "panNo") {
    const result = supplierSchema.shape[key].safeParse(values[key]);
    setErrors((current) => {
      const { [key]: _old, ...rest } = current;
      return result.success ? rest : { ...rest, [key]: result.error.issues[0]?.message ?? "Invalid value." };
    });
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Contact person" htmlFor="contactPerson" error={errors.contactPerson}>
            <input
              id="contactPerson"
              value={values.contactPerson}
              onChange={(event) => set("contactPerson", event.target.value)}
              className="input"
            />
          </Field>

          <Field
            label="Phone"
            htmlFor="phone"
            error={errors.phone}
            hint={errors.phone ? undefined : "10 digits, numbers only."}
          >
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={values.phone}
              // Digits only, however it is typed or pasted (spaces, dashes, +977 dropped).
              onChange={(event) => set("phone", digitsOnly(event.target.value, 10))}
              onBlur={() => check("phone")}
              placeholder="9841234567"
              aria-invalid={Boolean(errors.phone)}
              className="input tnum"
            />
          </Field>
        </div>

        <Field label="Email" htmlFor="email" error={errors.email}>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => set("email", event.target.value)}
            onBlur={() => check("email")}
            placeholder="orders@supplier.com.np"
            aria-invalid={Boolean(errors.email)}
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="PAN / VAT No."
            htmlFor="panNo"
            error={errors.panNo}
            hint={errors.panNo ? undefined : "9 digits. Needed on the purchase register."}
          >
            <input
              id="panNo"
              inputMode="numeric"
              value={values.panNo}
              onChange={(event) => set("panNo", digitsOnly(event.target.value, 9))}
              onBlur={() => check("panNo")}
              placeholder="301234567"
              aria-invalid={Boolean(errors.panNo)}
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
          label="Opening balance (Rs.)"
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
