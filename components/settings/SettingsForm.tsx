"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { apiFetch } from "@/lib/client";
import { cx } from "@/components/ui";
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
 * Validated with the same Zod schema the API enforces, so a nine-digit PAN
 * rule cannot drift between the two.
 */

export interface SettingsValues {
  businessName: string;
  legalName: string;
  pan: string;
  vatRegistered: boolean;
  vatNumber: string;
  /** A percentage in this form. The API stores the fraction. */
  vatRate: number;
  drugLicenceNo: string;
  registrationNo: string;
  address: string;
  city: string;
  phone: string;
  altPhone: string;
  email: string;
  website: string;
  billTerms: string;
  billFooterNote: string;
}

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const router = useRouter();
  const [values, setValues] = useState<SettingsValues>(initial);
  const [saved, setSaved] = useState<SettingsValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedAt(null);
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

    setValues(result.data);
    setSaved(result.data);
    setSavedAt(new Date().toLocaleTimeString());
    // The name and PAN are rendered on the server elsewhere - the page title,
    // the sign-in card, the next bill - so drop the cached render of them.
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-5">
        <div aria-live="polite">
          {formError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {formError}
            </div>
          ) : null}
        </div>

        <Section
          title="Identity"
          description="The name at the head of every bill, and the registered name if it differs."
        >
          <Field
            label="Pharmacy name"
            name="businessName"
            required
            value={values.businessName}
            error={errors.businessName}
            onChange={(value) => set("businessName", value)}
            hint="The trading name customers know you by."
          />
          <Field
            label="Registered name"
            name="legalName"
            value={values.legalName}
            error={errors.legalName}
            onChange={(value) => set("legalName", value)}
            hint="Optional. Printed under the trading name when the two differ."
          />
        </Section>

        <Section
          title="Tax registration"
          description="A tax invoice without a seller PAN is not valid. These print on every bill."
        >
          <Field
            label="PAN"
            name="pan"
            value={values.pan}
            error={errors.pan}
            onChange={(value) => set("pan", value)}
            inputMode="numeric"
            hint="Nine digits."
            className="tnum"
          />
          <Field
            label="VAT number"
            name="vatNumber"
            value={values.vatNumber}
            error={errors.vatNumber}
            onChange={(value) => set("vatNumber", value)}
            inputMode="numeric"
            hint="Usually the same as the PAN."
            className="tnum"
          />
          <Field
            label="VAT rate"
            name="vatRate"
            value={String(values.vatRate)}
            error={errors.vatRate}
            onChange={(value) => set("vatRate", Number(value))}
            inputMode="decimal"
            suffix="%"
            hint="Applies to new bills only. Past bills keep the rate they were charged at."
            className="tnum"
          />
          <label className="flex items-start gap-2.5 sm:col-span-2">
            <input
              type="checkbox"
              name="vatRegistered"
              checked={values.vatRegistered}
              onChange={(event) => set("vatRegistered", event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/25"
            />
            <span className="text-sm text-slate-700">
              This pharmacy is VAT registered
              <span className="block text-xs text-slate-500">
                Uncheck for a PAN-only business. The VAT number is then left off
                the bill.
              </span>
            </span>
          </label>
        </Section>

        <Section
          title="Licences"
          description="Kept on record and printed on the bill, where an inspector expects to find them."
        >
          <Field
            label="Drug licence number"
            name="drugLicenceNo"
            value={values.drugLicenceNo}
            error={errors.drugLicenceNo}
            onChange={(value) => set("drugLicenceNo", value)}
            hint="Department of Drug Administration."
          />
          <Field
            label="Registration number"
            name="registrationNo"
            value={values.registrationNo}
            error={errors.registrationNo}
            onChange={(value) => set("registrationNo", value)}
            hint="Company or firm registration."
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

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-slate-100/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
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

      <BillPreview values={values} />
    </form>
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
function BillPreview({ values }: { values: SettingsValues }) {
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
            <h1 className="receipt-shop">{values.businessName || "Your pharmacy"}</h1>
            {values.legalName ? <p>{values.legalName}</p> : null}
            {addressLine ? <p>{addressLine}</p> : null}
            {values.phone ? (
              <p>
                Tel: {values.phone}
                {values.altPhone ? `, ${values.altPhone}` : ""}
              </p>
            ) : null}
            {values.email ? <p>{values.email}</p> : null}
            <p className="receipt-pan">PAN: {values.pan || "—"}</p>
            {values.vatRegistered && values.vatNumber && values.vatNumber !== values.pan ? (
              <p>VAT: {values.vatNumber}</p>
            ) : null}
            {values.drugLicenceNo ? <p>DDA licence: {values.drugLicenceNo}</p> : null}
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
            {values.vatRegistered ? (
              <div>
                <dt>VAT {formatRate(values.vatRate)}%</dt>
                <dd>{((100 * (values.vatRate || 0)) / 100).toFixed(2)}</dd>
              </div>
            ) : null}
            <div className="grand">
              <dt>Grand total</dt>
              <dd>
                {(100 + (values.vatRegistered ? values.vatRate || 0 : 0)).toFixed(2)}
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
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
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
