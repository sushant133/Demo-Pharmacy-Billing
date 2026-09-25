"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { apiFetch } from "@/lib/client";
import { cx } from "@/components/ui";
import { MEDICINE_CATEGORIES } from "@/lib/constants";
import type { PlatformIdentity } from "@/lib/settings";
import { settingsSchema } from "@/lib/validation";

/**
 * The shop's own details.
 *
 * Everything here ends up on a printed tax invoice, so the form shows the
 * invoice. The preview beside the fields is built from the same CSS the real
 * bill uses, and redraws as you type: the question "will this look right on
 * the receipt" is answered without saving, printing, and finding out at the
 * counter.
 *
 * The registered identity - both names, the PAN, the VAT number and the
 * licences - is shown but not editable. MantraMed sets those when the
 * account is opened, because a shop that can type its own PAN can issue tax
 * invoices under a number nobody verified. They are still displayed, and
 * still drawn into the preview, since what matters day to day is whether the
 * bill is right rather than which half of the record a line came from.
 *
 * Validated with the same Zod schema the API enforces, and that schema has no
 * field for the locked values at all - which is what stops a hand-rolled
 * request writing one.
 */

export interface SettingsValues {
  /** A percentage in this form. The API stores the fraction. */
  vatRate: number;
  address: string;
  city: string;
  phone: string;
  altPhone: string;
  email: string;
  website: string;
  billTerms: string;
  billFooterNote: string;
  medicineCategories: string[];
}

/** The fields this form owns, picked out of a whole settings record. */
function editableOnly(record: SettingsValues): SettingsValues {
  return {
    vatRate: record.vatRate,
    address: record.address,
    city: record.city,
    phone: record.phone,
    altPhone: record.altPhone,
    email: record.email,
    website: record.website,
    billTerms: record.billTerms,
    billFooterNote: record.billFooterNote,
    medicineCategories: record.medicineCategories ?? [],
  };
}

export function SettingsForm({
  initial,
  identity,
}: {
  initial: SettingsValues;
  identity: PlatformIdentity;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SettingsValues>(() => editableOnly(initial));
  const [saved, setSaved] = useState<SettingsValues>(() => editableOnly(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [categoryHint, setCategoryHint] = useState<string | null>(null);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedAt(null);
  }

  function addCategory() {
    const name = categoryDraft.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (MEDICINE_CATEGORIES.some((entry) => entry.toLowerCase() === key)) {
      setCategoryHint(`“${name}” is already in the standard list.`);
      setCategoryDraft("");
      return;
    }
    if (values.medicineCategories.some((entry) => entry.toLowerCase() === key)) {
      setCategoryHint(`“${name}” is already added.`);
      setCategoryDraft("");
      return;
    }
    set("medicineCategories", [...values.medicineCategories, name]);
    setCategoryDraft("");
    setCategoryHint(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = settingsSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      document
        .querySelector<HTMLElement>(`[name="${Object.keys(fieldErrors)[0]}"]`)
        ?.focus();
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result = await apiFetch<SettingsValues>("/api/settings", {
      method: "PUT",
      json: parsed.data,
    });

    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      const details = result.details as Record<string, string[]> | undefined;
      if (details) {
        setErrors(
          Object.fromEntries(
            Object.entries(details).map(([key, list]) => [key, list[0] ?? ""]),
          ),
        );
      }
      return;
    }

    // The response carries the whole record, locked half included. Only the
    // editable half is kept, so the dirty check keeps comparing like with
    // like and a stray identity field can never ride along on the next save.
    const stored = editableOnly(result.data);
    setValues(stored);
    setSaved(stored);
    setSavedAt(new Date().toLocaleTimeString());
    // The address and phone are rendered on the server elsewhere - the next
    // bill, an exported report's letterhead - so drop the cached render.
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-5">
        <div aria-live="polite">
          {formError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {formError}
            </div>
          ) : null}
        </div>

        <RegisteredIdentity identity={identity} />

        <Section
          title="Tax rate"
          description="The rate charged on new bills. Past bills keep the rate they were charged at."
        >
          <Field
            label="VAT rate"
            name="vatRate"
            value={String(values.vatRate)}
            error={errors.vatRate}
            onChange={(value) => set("vatRate", Number(value))}
            inputMode="decimal"
            suffix="%"
            hint={
              identity.vatRegistered
                ? "13% in Nepal unless you have been told otherwise."
                : "This pharmacy is not VAT registered, so no VAT line is printed."
            }
            className="tnum"
          />
        </Section>

        <Section title="Contact" description="Where customers and suppliers reach you.">
          <Field
            label="Address"
            name="address"
            value={values.address}
            error={errors.address}
            onChange={(value) => set("address", value)}
            className="sm:col-span-2"
          />
          <Field
            label="City or district"
            name="city"
            value={values.city}
            error={errors.city}
            onChange={(value) => set("city", value)}
          />
          <Field
            label="Phone"
            name="phone"
            type="tel"
            value={values.phone}
            error={errors.phone}
            onChange={(value) => set("phone", value)}
            className="tnum"
          />
          <Field
            label="Alternate phone"
            name="altPhone"
            type="tel"
            value={values.altPhone}
            error={errors.altPhone}
            onChange={(value) => set("altPhone", value)}
            className="tnum"
          />
          <Field
            label="Email"
            name="email"
            type="email"
            value={values.email}
            error={errors.email}
            onChange={(value) => set("email", value)}
          />
          <Field
            label="Website"
            name="website"
            value={values.website}
            error={errors.website}
            onChange={(value) => set("website", value)}
            className="sm:col-span-2"
          />
        </Section>

        <Section
          title="Medicine categories"
          description="The usual list is always available. Add extra names your shop uses, such as Ayurvedic or Veterinary."
        >
          <div className="sm:col-span-2">
            <p className="mb-2 text-xs text-slate-500">
              Standard: {MEDICINE_CATEGORIES.filter((name) => name !== "Other").join(", ")}
              , then Other.
            </p>
            {values.medicineCategories.length > 0 ? (
              <ul className="mb-3 flex flex-wrap gap-1.5">
                {values.medicineCategories.map((name) => (
                  <li
                    key={name}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
                  >
                    {name}
                    <button
                      type="button"
                      onClick={() =>
                        set(
                          "medicineCategories",
                          values.medicineCategories.filter((entry) => entry !== name),
                        )
                      }
                      className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-rose-600"
                      aria-label={`Remove ${name}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-xs text-slate-500">No extra categories yet.</p>
            )}
            <div className="flex gap-2">
              <input
                id="settings-category-draft"
                value={categoryDraft}
                onChange={(event) => {
                  setCategoryDraft(event.target.value);
                  setCategoryHint(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCategory();
                  }
                }}
                placeholder="e.g. Ayurvedic"
                className="input"
                aria-label="New category name"
              />
              <button type="button" onClick={addCategory} className="btn-secondary shrink-0">
                Add
              </button>
            </div>
            {categoryHint ? (
              <p className="mt-1.5 text-xs text-amber-700">{categoryHint}</p>
            ) : (
              <p className="mt-1.5 text-xs text-slate-500">
                These appear in Add medicine. You can still type a one-off name by
                choosing Other.
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Bill wording"
          description="The two lines at the foot of every printed invoice."
        >
          <TextArea
            label="Terms"
            name="billTerms"
            value={values.billTerms}
            error={errors.billTerms}
            onChange={(value) => set("billTerms", value)}
            hint="Returns policy, or whatever the shop needs on record."
          />
          <TextArea
            label="Closing line"
            name="billFooterNote"
            value={values.billFooterNote}
            error={errors.billFooterNote}
            onChange={(value) => set("billFooterNote", value)}
            hint="The last thing the customer reads."
          />
        </Section>

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-slate-100/95 px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
          <button
            type="submit"
            disabled={submitting || !dirty}
            className="btn-primary px-6 py-2.5"
          >
            {submitting ? (
              <>
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                />
                Saving…
              </>
            ) : (
              "Save details"
            )}
          </button>

          {dirty ? (
            <button
              type="button"
              onClick={() => {
                setValues(saved);
                setErrors({});
                setFormError(null);
              }}
              className="btn-ghost"
            >
              Discard changes
            </button>
          ) : null}

          <p aria-live="polite" className="text-xs text-slate-500">
            {savedAt
              ? `Saved at ${savedAt}. New bills use these details.`
              : dirty
                ? "Unsaved changes."
                : "Up to date."}
          </p>
        </div>
      </div>

      <BillPreview values={values} identity={identity} />
    </form>
  );
}

/**
 * The registered identity, shown and not editable.
 *
 * Displayed rather than hidden: these are the lines an inspector reads off a
 * bill, and a shop that cannot see what its own invoice claims has no way to
 * notice a wrong digit. What it gets instead of an input is a way to report
 * one - which is the right shape, because correcting a PAN is a thing the
 * platform has to verify, not a field anybody can retype.
 */
function RegisteredIdentity({ identity }: { identity: PlatformIdentity }) {
  const rows: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: "Pharmacy name",
      value: identity.businessName,
      hint: "The trading name at the head of every bill.",
    },
    {
      label: "Registered name",
      value: identity.legalName,
      hint: "Printed under the trading name when the two differ.",
    },
    { label: "PAN", value: identity.pan, hint: "Nine digits." },
    {
      label: "VAT number",
      value: identity.vatRegistered ? identity.vatNumber : "",
      hint: identity.vatRegistered
        ? "Usually the same as the PAN."
        : "Not VAT registered, so nothing is printed.",
    },
    {
      label: "Drug licence number",
      value: identity.drugLicenceNo,
      hint: "Department of Drug Administration.",
    },
    {
      label: "Registration number",
      value: identity.registrationNo,
      hint: "Company or firm registration.",
    },
  ];

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Registered identity
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Set by MantraMed from your registration papers. These print on
            every bill.
          </p>
        </div>
        <span className="badge bg-slate-100 text-slate-600 ring-slate-200">
          Read only
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="label mb-0">{row.label}</dt>
            <dd
              className={cx(
                "mt-1 text-sm",
                row.value ? "text-slate-900" : "text-slate-400",
              )}
            >
              {row.value || "Not set"}
            </dd>
            {row.hint ? (
              <p className="mt-0.5 text-xs text-slate-400">{row.hint}</p>
            ) : null}
          </div>
        ))}
      </dl>

      <p className="mt-4 rounded-lg bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-600">
        Something wrong here? Contact MantraMed support with the corrected
        document. Changing a PAN or a licence number on a tax invoice is a
        change the platform has to be able to stand behind, which is why it is
        not a field you can edit.
      </p>
    </section>
  );
}

/**
 * The receipt, as it will print.
 *
 * Built from the same `.receipt` classes as the real invoice rather than a
 * lookalike, so what is shown here cannot quietly drift from what the printer
 * produces. The line items are stand-ins; everything drawn from settings is
 * live.
 */
function BillPreview({
  values,
  identity,
}: {
  values: SettingsValues;
  identity: PlatformIdentity;
}) {
  const addressLine = [values.address, values.city].filter(Boolean).join(", ");

  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
        Bill preview
      </p>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
        <article className="receipt">
          <header className="receipt-head">
            <p className="receipt-kicker">कर बीजक / TAX INVOICE</p>
            <h1 className="receipt-shop">{identity.businessName || "Your pharmacy"}</h1>
            {identity.legalName ? <p>{identity.legalName}</p> : null}
            {addressLine ? <p>{addressLine}</p> : null}
            {values.phone ? (
              <p>
                Tel: {values.phone}
                {values.altPhone ? `, ${values.altPhone}` : ""}
              </p>
            ) : null}
            {values.email ? <p>{values.email}</p> : null}
            <p className="receipt-pan">PAN: {identity.pan || "—"}</p>
            {identity.vatRegistered &&
            identity.vatNumber &&
            identity.vatNumber !== identity.pan ? (
              <p>VAT: {identity.vatNumber}</p>
            ) : null}
            {identity.drugLicenceNo ? (
              <p>DDA licence: {identity.drugLicenceNo}</p>
            ) : null}
          </header>

          <div className="receipt-meta">
            <div>
              <dt>Bill no.</dt>
              <dd>INV-000123</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>2083-05-14</dd>
            </div>
          </div>

          <table className="receipt-lines">
            <thead>
              <tr>
                <th className="left">Item</th>
                <th className="right">Qty</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="left">
                  Paracetamol 500mg
                  <span className="muted"> — sample line</span>
                </td>
                <td className="right">10</td>
                <td className="right">100.00</td>
              </tr>
            </tbody>
          </table>

          <dl className="receipt-totals">
            <div>
              <dt>Taxable</dt>
              <dd>100.00</dd>
            </div>
            {identity.vatRegistered ? (
              <div>
                <dt>VAT {formatRate(values.vatRate)}%</dt>
                <dd>{((100 * (values.vatRate || 0)) / 100).toFixed(2)}</dd>
              </div>
            ) : null}
            <div className="grand">
              <dt>Grand total</dt>
              <dd>
                {(100 + (identity.vatRegistered ? values.vatRate || 0 : 0)).toFixed(2)}
              </dd>
            </div>
          </dl>

          <footer className="receipt-foot">
            <p className="sign">Authorised signatory ________________</p>
            {values.billTerms ? <p className="tiny">{values.billTerms}</p> : null}
            {values.billFooterNote ? (
              <p className="tiny">{values.billFooterNote}</p>
            ) : null}
          </footer>
        </article>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Line items are a sample. Everything else redraws as you type, and is what
        the next bill will carry.
      </p>
    </aside>
  );
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "0";
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  name,
  value,
  onChange,
  error,
  hint,
  required,
  type = "text",
  inputMode,
  suffix,
  className,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: string;
  inputMode?: "numeric" | "decimal" | "email" | "tel" | "text";
  suffix?: string;
  className?: string;
}) {
  const id = `settings-${name}`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={cx(className?.includes("col-span") ? className : undefined)}>
      <label htmlFor={id} className="label">
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={cx(
            "input",
            suffix && "pr-8",
            className?.includes("tnum") && "tnum",
            error && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/25",
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400">
            {suffix}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function TextArea({
  label,
  name,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  const id = `settings-${name}`;

  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cx(
          "input",
          error && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/25",
        )}
      />
      {error ? (
        <p className="mt-1 text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}
