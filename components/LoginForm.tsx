"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cx } from "@/components/ui";
import { loginSchema } from "@/lib/validation";
import type { ApiResponse } from "@/lib/api";

/**
 * Credential form.
 *
 * Validates with the same Zod schema the API uses, so an obvious mistake
 * (empty password, malformed email) is caught before a round trip and the
 * wording matches what the server would have said.
 *
 * The extras here are the ones a counter actually needs. A password typed fast
 * on a shared keyboard fails most often because Caps Lock is on, so that is
 * warned about rather than left to a second rejected attempt; the reveal
 * toggle lets someone check a password they are typing with a queue waiting;
 * and a failed submit puts focus back where the fix is.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  /**
   * Caps Lock state is only knowable from a key event, so it is read on the
   * password field and cleared when that field is left.
   */
  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      // Land the cursor on the first thing that needs fixing.
      (fieldErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json()) as ApiResponse<unknown>;

      if (!body.ok) {
        setFormError(body.error.message);
        setSubmitting(false);
        // The password is the likely culprit, and retyping it is the next
        // action either way. Clearing it also keeps a wrong one off a shared
        // screen.
        setPassword("");
        passwordRef.current?.focus();
        return;
      }

      // A full document load rather than router.replace: the client router
      // would fetch the destination as an RSC payload, and if that render
      // throws - an account with no branch, say - the navigation never
      // resolves and the button sits on "Signing in…" for ever. A real
      // navigation always lands somewhere, even if it lands on an error page.
      window.location.assign(next);
    } catch {
      setFormError(
        "Could not reach the server. Check the connection to the shop network and try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {/*
        aria-live rather than role="alert" on a conditional node: the region is
        always present, so a screen reader announces the message when it
        arrives instead of racing the node's insertion.
      */}
      <div aria-live="polite">
        {formError ? (
          <div className="flex gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
            <svg
              className="mt-px h-4.5 w-4.5 shrink-0 text-rose-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
              />
            </svg>
            <span>{formError}</span>
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input
          ref={emailRef}
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-error" : undefined}
          className="login-input"
          placeholder="you@pharmacy.com"
        />
        {errors.email ? (
          <p id="email-error" className="mt-1.5 text-xs text-rose-600">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="password" className="label">
            Password
          </label>
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-pressed={revealed}
            aria-controls="password"
            className="mb-1.5 rounded text-xs font-medium text-slate-500 transition-colors hover:text-brand-700"
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </div>
        <input
          ref={passwordRef}
          id="password"
          name="password"
          type={revealed ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyUp={trackCapsLock}
          onKeyDown={trackCapsLock}
          onBlur={() => setCapsLock(false)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby={
            cx(errors.password && "password-error", capsLock && "caps-lock") ||
            undefined
          }
          className="login-input"
          placeholder="Your counter password"
        />
        {errors.password ? (
          <p id="password-error" className="mt-1.5 text-xs text-rose-600">
            {errors.password}
          </p>
        ) : null}
        {capsLock ? (
          <p
            id="caps-lock"
            className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4l7 7h-4v4H9v-4H5l7-7zM9 19h6"
              />
            </svg>
            Caps Lock is on.
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
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
