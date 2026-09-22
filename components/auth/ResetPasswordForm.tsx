"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client";
import { resetPasswordSchema } from "@/lib/validation";

/**
 * Choose a new password against a link.
 *
 * No session is issued when this succeeds - the API deliberately does not
 * sign anybody in - so the screen sends them to the sign-in page to use the
 * password they just chose. Typing it once more is the cheap confirmation
 * that it is the one they meant.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = resetPasswordSchema.safeParse({ token, password, confirm });
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
    const result = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      json: parsed.data,
    });
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    setDone(true);
    // Straight to sign-in, but leave the confirmation up long enough to read.
    setTimeout(() => router.push("/login"), 2500);
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm leading-relaxed text-emerald-900">
            Your password has been changed. Taking you to sign in…
          </p>
        </div>
        <Link href="/login" className="btn-primary w-full">
          Sign in now
        </Link>
      </div>
    );
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
          autoFocus
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
          "Set new password"
        )}
      </button>
    </form>
  );
}
