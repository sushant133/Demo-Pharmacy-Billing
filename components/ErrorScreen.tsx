"use client";

import { useEffect } from "react";

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
  useEffect(() => {
    // Production strips the message from the client, so this is mostly for
    // local debugging - but a digest here still matches the server log.
    console.error("[render error]", error.digest ?? "", error);
  }, [error]);

  return (
    <div
      className={
        full
          ? "flex min-h-dvh items-center justify-center px-4"
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
          The shop&rsquo;s database didn&rsquo;t answer in time. Nothing was
          saved or changed - try again and it should come straight back.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          <a href="/dashboard" className="btn-secondary">
            Back to dashboard
          </a>
        </div>

        {error.digest ? (
          <p className="mt-6 font-mono text-[11px] text-slate-400">
            Reference {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
