"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client";
import { forgotPasswordSchema } from "@/lib/validation";

/**
 * Ask for a reset link.
 *
 * On success the screen says the same thing whether or not the address has an
 * account, because the API does - a form that answered "no such account"
 * would let anyone test whether a given pharmacy owner is on the platform.
 * That makes the confirmation deliberately non-committal, so it also tells
 * people where to look and what to do if nothing arrives.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
      return;
    }

    setSubmitting(true);
    const result = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      json: parsed.data,
    });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSentTo(parsed.data.email);
  }

  if (sentTo) {
    return (
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8 6 8-6M4 6h16v12H4z" />
          </svg>
          <p className="text-sm leading-relaxed text-emerald-900">
            If <span className="font-medium">{sentTo}</span> has an account, a
            reset link is on its way. It works once and expires in an hour.
          </p>
        </div>

        <p className="text-xs leading-relaxed text-slate-500">
          Nothing after a few minutes? Check the spam folder, and check the
          address is the one the account was opened with. You can{" "}
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="font-medium text-brand-700 underline hover:text-brand-800"
          >
            try a different address
          </button>
          .
        </p>

        <Link href="/login" className="btn-secondary w-full">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div aria-live="polite">
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
            {error}
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor="email" className="label">
          Registered email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(fieldError)}
          aria-describedby={fieldError ? "email-error" : undefined}
          className="login-input"
          placeholder="you@pharmacy.com"
        />
        {fieldError ? (
          <p id="email-error" className="mt-1.5 text-xs text-rose-600">
            {fieldError}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="btn-primary w-full py-3 text-[15px]"
      >
        {submitting ? (
          <>
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
            Sending…
          </>
        ) : (
          "Email me a reset link"
        )}
      </button>

      <Link
        href="/login"
        className="block text-center text-sm font-medium text-slate-500 hover:text-brand-700"
      >
        Back to sign in
      </Link>
    </form>
  );
}
