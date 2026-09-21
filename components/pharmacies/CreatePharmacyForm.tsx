"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client";
import {
  DEFAULT_PRINT_TEMPLATE,
  PRINT_TEMPLATE_LIST,
} from "@/lib/print-templates";
import { createPharmacySchema } from "@/lib/validation";

/**
 * Opening an account.
 *
 * Four fields are required - the shop's name and the three that make a
 * working login - and everything else is paperwork that can follow. That is
 * not laziness: an account is usually opened while the owner is on the phone,
 * and a form that demands a drug licence number before it will save is a form
 * that gets a made-up number typed into it.
 */
export function CreatePharmacyForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const raw = Object.fromEntries(form.entries());
    const parsed = createPharmacySchema.safeParse(raw);
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
    setSubmitting(true);

    const result = await apiFetch<{ id: string }>("/api/pharmacies", {
      method: "POST",
      json: parsed.data,
    });

    if (!result.ok) {
      setFormError(result.message);
      setSubmitting(false);
      return;
    }

    router.push(`/superadmin/pharmacies/${result.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card max-w-2xl space-y-5 p-5 sm:p-6">
      {formError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          {formError}
        </div>
      ) : null}

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Pharmacy</legend>
        <div>
          <label htmlFor="name" className="label">
            Trading name
          </label>
          <input id="name" name="name" required className="input" placeholder="Sagarmatha Pharmacy" />
          {errors.name ? <p className="mt-1.5 text-xs text-rose-600">{errors.name}</p> : null}
        </div>
        <div>
          <label htmlFor="legalName" className="label">
            Registered name <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input id="legalName" name="legalName" className="input" />
        </div>
        <div>
          <label htmlFor="slug" className="label">
            Short code <span className="font-normal text-slate-400">(optional — generated from the name)</span>
          </label>
          <input id="slug" name="slug" className="input" placeholder="sagarmatha-pharmacy" />
          {errors.slug ? <p className="mt-1.5 text-xs text-rose-600">{errors.slug}</p> : null}
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="text-sm font-semibold text-slate-900">
          Registration &amp; licences
        </legend>
        <p className="text-sm text-slate-500">
          All optional. Fill in what you have; the rest can be added from the
          pharmacy&rsquo;s own page when the paperwork arrives.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="pan" className="label">
              PAN <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="pan" name="pan" className="input" inputMode="numeric" maxLength={9} />
            <p className="mt-1.5 text-xs text-slate-500">
              Nine digits. Printed on every tax invoice the shop issues.
            </p>
            {errors.pan ? <p className="mt-1.5 text-xs text-rose-600">{errors.pan}</p> : null}
          </div>
          <div>
            <label htmlFor="registrationNo" className="label">
              Company / firm registration{" "}
              <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="registrationNo" name="registrationNo" className="input" />
          </div>
          <div>
            <label htmlFor="drugLicenceNo" className="label">
              DDA drug licence <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="drugLicenceNo" name="drugLicenceNo" className="input" />
          </div>
          <div>
            <label htmlFor="licenceExpiry" className="label">
              Licence expiry <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="licenceExpiry" name="licenceExpiry" type="date" className="input" />
            {errors.licenceExpiry ? (
              <p className="mt-1.5 text-xs text-rose-600">{errors.licenceExpiry}</p>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="text-sm font-semibold text-slate-900">Contact</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="address" className="label">
              Address <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="address" name="address" className="input" />
          </div>
          <div>
            <label htmlFor="city" className="label">
              City <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="city" name="city" className="input" />
          </div>
          <div>
            <label htmlFor="phone" className="label">
              Shop phone <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="phone" name="phone" className="input" />
          </div>
          <div>
            <label htmlFor="email" className="label">
              Shop email <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="email" name="email" type="email" className="input" />
            {errors.email ? (
              <p className="mt-1.5 text-xs text-rose-600">{errors.email}</p>
            ) : null}
          </div>
        </div>
        <div>
          <label htmlFor="printTemplate" className="label">
            Bill template
          </label>
          {/*
            Asked at the counter, not guessed: "what printer do you have?" is
            a question the owner can answer on the phone while the account is
            being opened, and it is the one setting that makes their first
            bill come out the right size. Changeable afterwards from the
            pharmacy's own page.
          */}
          <select
            id="printTemplate"
            name="printTemplate"
            className="input"
            defaultValue={DEFAULT_PRINT_TEMPLATE}
          >
            {PRINT_TEMPLATE_LIST.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label} — {template.printer}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-slate-500">
            What the shop&rsquo;s printer can produce.{" "}
            <Link
              href="/superadmin/templates"
              className="font-medium text-brand-700 hover:text-brand-800"
            >
              Compare the layouts
            </Link>{" "}
            if they are not sure.
          </p>
          {errors.printTemplate ? (
            <p className="mt-1.5 text-xs text-rose-600">{errors.printTemplate}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="notes" className="label">
            Internal notes <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea id="notes" name="notes" rows={2} className="input" />
          <p className="mt-1.5 text-xs text-slate-500">
            Only the platform sees these. The shop never does.
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="text-sm font-semibold text-slate-900">Owner login</legend>
        <p className="text-sm text-slate-500">
          This is the account you hand to the pharmacy. They sign in on the same
          screen as everyone else and only see their own shop.
        </p>
        <div>
          <label htmlFor="ownerName" className="label">
            Owner name
          </label>
          <input id="ownerName" name="ownerName" required className="input" />
          {errors.ownerName ? (
            <p className="mt-1.5 text-xs text-rose-600">{errors.ownerName}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="ownerEmail" className="label">
            Email
          </label>
          <input
            id="ownerEmail"
            name="ownerEmail"
            type="email"
            required
            className="input"
            placeholder="owner@pharmacy.com"
          />
          {errors.ownerEmail ? (
            <p className="mt-1.5 text-xs text-rose-600">{errors.ownerEmail}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="ownerPassword" className="label">
            Temporary password
          </label>
          <input
            id="ownerPassword"
            name="ownerPassword"
            type="text"
            required
            minLength={8}
            className="input"
            autoComplete="new-password"
          />
          {errors.ownerPassword ? (
            <p className="mt-1.5 text-xs text-rose-600">{errors.ownerPassword}</p>
          ) : null}
          <p className="mt-1.5 text-xs text-slate-500">
            Give this to the owner in person. They can change it later from their shop.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ownerPhone" className="label">
              Owner phone <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="ownerPhone" name="ownerPhone" className="input" />
          </div>
          <div>
            <label htmlFor="ownerCitizenshipNo" className="label">
              Citizenship number <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="ownerCitizenshipNo" name="ownerCitizenshipNo" className="input" />
            <p className="mt-1.5 text-xs text-slate-500">
              Know-your-customer only. Never printed, never shown to the shop.
            </p>
            {errors.ownerCitizenshipNo ? (
              <p className="mt-1.5 text-xs text-rose-600">{errors.ownerCitizenshipNo}</p>
            ) : null}
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? "Creating…" : "Create pharmacy"}
        </button>
      </div>
    </form>
  );
}
