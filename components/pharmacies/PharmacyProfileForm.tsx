"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { updatePharmacySchema } from "@/lib/validation";

export interface PharmacyProfileValues {
  name: string;
  legalName: string;
  pan: string;
  vatNumber: string;
  vatRegistered: boolean;
  registrationNo: string;
  drugLicenceNo: string;
  /** YYYY-MM-DD, or "" - what <input type="date"> wants either way. */
  licenceExpiry: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  ownerPhone: string;
  ownerCitizenshipNo: string;
  notes: string;
}

/**
 * The platform's record of one shop, editable in place.
 *
 * Read-only until "Edit" is pressed. A page whose every field is a live input
 * invites a stray keystroke into a licence number nobody meant to touch, and
 * most visits to this screen are to read it, not change it.
 *
 * The identity fields here - both names, the PAN, the VAT number, the
 * registration and the drug licence - are the shop's printed bill header.
 * The pharmacy reads them on its own Settings screen and cannot change them,
 * because a shop that can type its own PAN can issue tax invoices under a
 * number nobody verified. Everything else on that screen, its address, terms
 * and footer line, stays the shop's.
 *
 * Saving here therefore changes what the next bill prints. The address and
 * phone in this form do not: those were the seed for the shop's own record
 * and it has owned them ever since.
 */
export function PharmacyProfileForm({
  pharmacyId,
  initial,
}: {
  pharmacyId: string;
  initial: PharmacyProfileValues;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof PharmacyProfileValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function cancel() {
    setValues(initial);
    setErrors({});
    setFormError(null);
    setEditing(false);
  }

  async function save() {
    setFormError(null);
    const parsed = updatePharmacySchema.safeParse(values);
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
    const result = await apiFetch(`/api/pharmacies/${pharmacyId}`, {
      method: "PATCH",
      json: parsed.data,
    });
    setSaving(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    setSaved(true);
    setEditing(false);
    router.refresh();
  }

  const rows: Array<[string, string]> = [
    ["Registered name", values.legalName],
    ["PAN", values.pan],
    ["VAT number", values.vatRegistered ? values.vatNumber : "Not VAT registered"],
    ["Company / firm registration", values.registrationNo],
    ["DDA drug licence", values.drugLicenceNo],
    ["Licence expiry", values.licenceExpiry],
    ["Address", [values.address, values.city].filter(Boolean).join(", ")],
    ["Shop phone", values.phone],
    ["Shop email", values.email],
    ["Owner phone", values.ownerPhone],
    ["Citizenship number", values.ownerCitizenshipNo],
  ];

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Record</h2>
          <p className="mt-1 text-sm text-slate-500">
            The names, tax numbers and licences print on this shop&rsquo;s
            bills, and it can read but not change them. The owner phone,
            citizenship number and notes are the platform&rsquo;s alone.
          </p>
        </div>
        {editing ? null : (
          <button type="button" onClick={() => setEditing(true)} className="btn-secondary">
            Edit
          </button>
        )}
      </div>

      {saved && !editing ? (
        <p className="mt-3 text-sm text-emerald-700">Saved.</p>
      ) : null}

      {formError ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          {formError}
        </div>
      ) : null}

      {editing ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Text
              id="name"
              label="Trading name"
              value={values.name}
              error={errors.name}
              hint="What the owner sees in their sidebar and on the sign-in card."
              onChange={(value) => set("name", value)}
            />
            <Text
              id="legalName"
              label="Registered name"
              value={values.legalName}
              error={errors.legalName}
              onChange={(value) => set("legalName", value)}
            />
            <Text
              id="pan"
              label="PAN"
              value={values.pan}
              error={errors.pan}
              hint="Nine digits, or blank."
              onChange={(value) => set("pan", value)}
            />
            <Text
              id="vatNumber"
              label="VAT number"
              value={values.vatNumber}
              error={errors.vatNumber}
              hint="Usually the same as the PAN. Nine digits, or blank."
              onChange={(value) => set("vatNumber", value)}
            />
            <Text
              id="registrationNo"
              label="Company / firm registration"
              value={values.registrationNo}
              error={errors.registrationNo}
              onChange={(value) => set("registrationNo", value)}
            />
            <Text
              id="drugLicenceNo"
              label="DDA drug licence"
              value={values.drugLicenceNo}
              error={errors.drugLicenceNo}
              onChange={(value) => set("drugLicenceNo", value)}
            />
            <Text
              id="licenceExpiry"
              label="Licence expiry"
              type="date"
              value={values.licenceExpiry}
              error={errors.licenceExpiry}
              onChange={(value) => set("licenceExpiry", value)}
            />
            <Text
              id="address"
              label="Address"
              value={values.address}
              error={errors.address}
              onChange={(value) => set("address", value)}
            />
            <Text
              id="city"
              label="City"
              value={values.city}
              error={errors.city}
              onChange={(value) => set("city", value)}
            />
            <Text
              id="phone"
              label="Shop phone"
              value={values.phone}
              error={errors.phone}
              onChange={(value) => set("phone", value)}
            />
            <Text
              id="email"
              label="Shop email"
              type="email"
              value={values.email}
              error={errors.email}
              onChange={(value) => set("email", value)}
            />
            <Text
              id="ownerPhone"
              label="Owner phone"
              value={values.ownerPhone}
              error={errors.ownerPhone}
              onChange={(value) => set("ownerPhone", value)}
            />
            <Text
              id="ownerCitizenshipNo"
              label="Citizenship number"
              value={values.ownerCitizenshipNo}
              error={errors.ownerCitizenshipNo}
              hint="Know-your-customer only. Never printed."
              onChange={(value) => set("ownerCitizenshipNo", value)}
            />
          </div>

          {/*
            Unchecking this leaves VAT off the shop's bills entirely, so it
            sits apart from the numbers rather than among them.
          */}
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={values.vatRegistered}
              onChange={(event) => {
                setValues((current) => ({
                  ...current,
                  vatRegistered: event.target.checked,
                }));
                setSaved(false);
              }}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/25"
            />
            <span className="text-sm text-slate-700">
              This pharmacy is VAT registered
              <span className="block text-xs text-slate-500">
                Uncheck for a PAN-only business. Its bills then carry no VAT
                number and no VAT line.
              </span>
            </span>
          </label>

          <div>
            <label htmlFor="notes" className="label">
              Internal notes
            </label>
            <textarea
              id="notes"
              rows={3}
              className="input"
              value={values.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
            {errors.notes ? (
              <p className="mt-1.5 text-xs text-rose-600">{errors.notes}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={save} disabled={saving} className="btn-primary">
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={cancel} className="btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  {label}
                </dt>
                <dd className="mt-1 text-sm text-slate-900">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          {values.notes ? (
            <div className="mt-4 rounded-lg bg-slate-50 px-3.5 py-3">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Internal notes
              </p>
              <p className="mt-1 text-sm whitespace-pre-line text-slate-700">
                {values.notes}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Text({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
      {error ? <p className="mt-1.5 text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
