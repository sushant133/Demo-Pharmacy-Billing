"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Field, SlideOver } from "@/components/SlideOver";
import { branchSchema } from "@/lib/validation";

export interface BranchFormValues {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  panNo: string;
  notes: string;
  isDefault: boolean;
  isActive: boolean;
}

export function BranchFormPanel({
  branch,
  returnTo = "/branches",
}: {
  branch: BranchFormValues | null;
  returnTo?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(branch);

  const [values, setValues] = useState({
    code: branch?.code ?? "",
    name: branch?.name ?? "",
    address: branch?.address ?? "",
    phone: branch?.phone ?? "",
    panNo: branch?.panNo ?? "",
    notes: branch?.notes ?? "",
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
    const parsed = branchSchema.safeParse(values);
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
      isEdit ? `/api/branches/${branch!.id}` : "/api/branches",
      { method: isEdit ? "PATCH" : "POST", json: parsed.data },
    );

    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  async function makeDefault() {
    if (!branch) return;
    setSaving(true);
    setFormError(null);
    const result = await apiFetch(`/api/branches/${branch.id}/default`, { method: "POST" });
    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }
    close();
  }

  async function closeOutlet() {
    if (!branch) return;
    setSaving(true);
    setFormError(null);
    const result = await apiFetch(`/api/branches/${branch.id}/close`, { method: "POST" });
    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }
    close();
  }

  return (
    <SlideOver
      title={isEdit ? "Edit branch" : "Add branch"}
      description={
        isEdit
          ? "Printed bills from this outlet use this name, address and PAN."
          : "A physical outlet. Stock, sales and receipts stay here until you transfer them."
      }
      onClose={close}
      footer={
        <div className="flex flex-col gap-2">
          {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="btn-primary flex-1"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add branch"}
            </button>
            <button type="button" onClick={close} className="btn-secondary">
              Cancel
            </button>
          </div>
          {isEdit && branch?.isActive !== false ? (
            <div className="flex items-center gap-2">
              {!branch?.isDefault ? (
                <button
                  type="button"
                  onClick={makeDefault}
                  disabled={saving}
                  className="btn-secondary flex-1"
                >
                  Make default
                </button>
              ) : null}
              {!branch?.isDefault ? (
                <button
                  type="button"
                  onClick={closeOutlet}
                  disabled={saving}
                  className="btn-ghost text-rose-700"
                >
                  Close branch
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Code" htmlFor="code" error={errors.code} hint="Used in URLs. Lowercase, letters, numbers and hyphens.">
          <input
            id="code"
            className="input"
            value={values.code}
            onChange={(event) => set("code", event.target.value)}
            disabled={isEdit}
          />
        </Field>
        <Field label="Name" htmlFor="name" error={errors.name}>
          <input
            id="name"
            className="input"
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <Field label="Address" htmlFor="address" error={errors.address}>
          <textarea
            id="address"
            className="input min-h-[4.5rem]"
            value={values.address}
            onChange={(event) => set("address", event.target.value)}
          />
        </Field>
        <Field label="Phone" htmlFor="phone" error={errors.phone}>
          <input
            id="phone"
            className="input"
            value={values.phone}
            onChange={(event) => set("phone", event.target.value)}
          />
        </Field>
        <Field
          label="PAN"
          htmlFor="panNo"
          error={errors.panNo}
          hint="Blank uses the company PAN on printed bills."
        >
          <input
            id="panNo"
            className="input"
            value={values.panNo}
            onChange={(event) => set("panNo", event.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="notes" error={errors.notes}>
          <textarea
            id="notes"
            className="input min-h-[4rem]"
            value={values.notes}
            onChange={(event) => set("notes", event.target.value)}
          />
        </Field>
      </div>
    </SlideOver>
  );
}
