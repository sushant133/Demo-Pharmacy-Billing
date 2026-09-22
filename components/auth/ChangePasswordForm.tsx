"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client";
import { changePasswordSchema } from "@/lib/validation";

/**
 * Replace the temporary password with one of the owner's choosing.
 *
 * The API re-signs the session on success, so this goes straight on to the
 * shop - with a full document load, as sign-in does, so every server
 * component renders against the new cookie rather than a cached one.
 */
export function ChangePasswordForm({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = changePasswordSchema.safeParse({ currentPassword, password, confirm });
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
    const result = await apiFetch<{ next: string }>("/api/auth/change-password", {
      method: "POST",
      json: parsed.data,
    });

    if (!result.ok) {
      setFormError(result.message);
      setSubmitting(false);
      return;
    }

    window.location.assign(result.data.next);
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div aria-live="polite">
        {formError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
            {formError}
          </div>
        ) : null}
      </div>

      {/* Lets a password manager file the new password under the right login. */}
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />

      <div>
        <label htmlFor="currentPassword" className="label">
          Temporary password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type={revealed ? "text" : "password"}
          autoComplete="current-password"
          autoFocus
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          aria-invalid={Boolean(errors.currentPassword)}
          className="login-input"
          placeholder="From your welcome email"
        />
        {errors.currentPassword ? (
          <p className="mt-1.5 text-xs text-rose-600">{errors.currentPassword}</p>
        ) : null}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="password" className="label">
            New password
          </label>
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-pressed={revealed}
            className="mb-1.5 rounded text-xs font-medium text-slate-500 transition-colors hover:text-brand-700"
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="password"
          name="password"
          type={revealed ? "text" : "password"}
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(errors.password)}
          className="login-input"
          placeholder="At least 8 characters"
        />
        {errors.password ? (
          <p className="mt-1.5 text-xs text-rose-600">{errors.password}</p>
        ) : null}
      </div>

      <div>
        <label htmlFor="confirm" className="label">
          Type it again
        </label>
        <input
          id="confirm"
          name="confirm"
          type={revealed ? "text" : "password"}
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          aria-invalid={Boolean(errors.confirm)}
          className="login-input"
        />
        {errors.confirm ? (
          <p className="mt-1.5 text-xs text-rose-600">{errors.confirm}</p>
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
            Saving…
          </>
        ) : (
          "Save and continue"
        )}
      </button>

      <button
        type="button"
        onClick={signOut}
        className="block w-full text-center text-sm font-medium text-slate-500 hover:text-brand-700"
      >
        Sign out
      </button>
    </form>
  );
}
