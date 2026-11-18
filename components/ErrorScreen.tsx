"use client";

import { useEffect, useMemo } from "react";

/** Silent retries per screen before the error is shown. Most failures are a cold pool. */
const AUTO_RETRY_KEY = "mp_error_autoretry";
const AUTO_RETRY_WINDOW_MS = 30_000;

/**
 * What a staff member sees when a screen fails to render.
 *
 * The overwhelmingly likely cause is a database round trip that lost its
 * connection - a hosted deployment freezes idle containers and their sockets
 * die with them - and the honest response to that is "try again", because the
 * next attempt opens a fresh pool and almost always works. So the retry button
 * is the main thing on the page, and the copy says what happened in the words
 * of someone standing at a counter rather than reporting a stack trace.
 *
 * The digest is printed small at the bottom: it is the only handle that ties
 * this screen to the matching line in the server log, and asking someone to
 * read a number back over the phone is easier than asking them to reproduce.
 */
export function ErrorScreen({
  error,
  reset,
  title = "This screen didn't load",
  full = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  full?: boolean;
}) {
  /*
    A reference that is unique to this failure. Next's digest is a hash of the
    error, so the same fault gives the same digest every time - useless for
    telling two reports apart. The digest stays (it finds the stack in the
    server log, logged by instrumentation's onRequestError) and a timestamp
    plus a random tag make the whole reference unique.
  */
  const reference = useMemo(() => {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS
    const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${error.digest ?? "client"}-${stamp}-${tag}`;
  }, [error]);

  useEffect(() => {
    // Production strips the message from the client, so this is mostly for
    // local debugging - but a digest here still matches the server log.
    console.error("[render error]", reference, error);
  }, [error, reference]);

  // One silent retry per screen: a thawed server's first query is the usual
  // cause, and the second render almost always succeeds. Guarded so a screen
  // that really is broken shows this page instead of looping.
  useEffect(() => {
    try {
      const path = window.location.pathname;
      const last = JSON.parse(sessionStorage.getItem(AUTO_RETRY_KEY) ?? "null") as
        | { path: string; at: number }
        | null;
      if (last && last.path === path && Date.now() - last.at < AUTO_RETRY_WINDOW_MS) return;
      sessionStorage.setItem(AUTO_RETRY_KEY, JSON.stringify({ path, at: Date.now() }));
      const timer = window.setTimeout(reset, 800);
      return () => window.clearTimeout(timer);
    } catch {
      // No storage: never auto-retry, so a broken screen cannot loop.
    }
  }, [reset]);

  return (
    <div
      className={
        full
          ? "flex min-h-dvh items-center justify-center px-4 pt-[var(--safe-top)] pb-[var(--safe-bottom)]"
          : "flex min-h-[60vh] items-center justify-center px-4"
      }
    >
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <svg
            className="h-6 w-6 text-amber-700"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
            />
          </svg>
        </div>

        <h1 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          The server didn&rsquo;t answer in time or hit a problem. Nothing was
          saved or changed - try again and it should come straight back. If it
          keeps happening, send the reference below to support.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          <a href="/dashboard" className="btn-secondary">
            Back to dashboard
          </a>
        </div>

        <p className="mt-6 font-mono text-[11px] text-slate-500 select-all">
          Reference {reference}
        </p>
      </div>
    </div>
  );
}
