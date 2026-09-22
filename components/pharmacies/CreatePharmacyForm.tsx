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
 * Three fields are required - the shop's name and the owner's name and
 * email; the password is generated and emailed by the server - and
 * everything else is paperwork that can follow. That is
 * not laziness: an account is usually opened while the owner is on the phone,
 * and a form that demands a drug licence number before it will save is a form
 * that gets a made-up number typed into it.
 */
export function CreatePharmacyForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [undelivered, setUndelivered] = useState<{
    id: string;
    email: string;
    password: string;
    reason: string;
  } | null>(null);

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

    const result = await apiFetch<{
      id: string;
      ownerEmail: string;
      credentialsEmailed: boolean;
      temporaryPassword?: string;
      emailError?: string;
    }>("/api/pharmacies", {
      method: "POST",
      json: parsed.data,
    });

    if (!result.ok) {
      setFormError(result.message);
      setSubmitting(false);
      return;
    }

    // The email did not go out: the only copy of the password is this
    // response, so hold the screen until superadmin has passed it on.
    if (!result.data.credentialsEmailed && result.data.temporaryPassword) {
      setUndelivered({
        id: result.data.id,
        email: result.data.ownerEmail,
        password: result.data.temporaryPassword,
        reason: result.data.emailError ?? "",
      });
      return;
    }

    router.push(`/superadmin/pharmacies/${result.data.id}`);
    router.refresh();
  }

  if (undelivered) {
    return (
      <div className="card max-w-2xl space-y-4 p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Pharmacy created</h2>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
          The login details could not be emailed. Pass these to the owner
          yourself. This password will not be shown again. They will be asked
          to change it when they first sign in.
          {undelivered.reason ? (
            <p className="mt-2 break-words text-xs text-amber-800">
              <span className="font-semibold">Why:</span> {undelivered.reason}
            </p>
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-500">Login ID</dt>
          <dd className="font-medium text-slate-900">{undelivered.email}</dd>
          <dt className="text-slate-500">Temporary password</dt>
          <dd className="font-mono font-medium text-slate-900">{undelivered.password}</dd>
        </dl>
        <div className="flex justify-end border-t border-slate-100 pt-4">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              router.push(`/superadmin/pharmacies/${undelivered.id}`);
              router.refresh();
            }}
          >
            Continue to pharmacy
          </button>
        </div>
      </div>
    );
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
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-600">
          A temporary password is generated automatically and emailed to this
          address with the login ID. The owner is asked to choose their own
          password the first time they sign in.
        </p>
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
