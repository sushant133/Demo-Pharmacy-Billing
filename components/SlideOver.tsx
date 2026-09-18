"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Right-hand slide-over used for add/edit forms.
 *
 * The forms live in a panel rather than a separate page so staff never lose
 * the list they were looking at. Open state is carried in the URL by the
 * caller, which keeps the panel linkable and refresh-safe.
 */
export function SlideOver({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);

    // Focus the first field so the panel is immediately typeable.
    const firstField = panelRef.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, textarea",
    );
    firstField?.focus();

    // Stop the list behind the panel from scrolling under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />

      {/*
        `h-dvh`, not `h-full`: on a phone browser the URL bar is part of the
        layout viewport, so a 100%-height panel put its footer - the Save
        button - under the chrome, and the only way to reach it was to scroll
        a panel that reported itself as fully scrolled.
      */}
      <div
        ref={panelRef}
        className="relative flex h-dvh w-full max-w-md flex-col bg-white shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-balance text-slate-900">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs break-words text-slate-500">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-1 shrink-0 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {children}
        </div>

        {/*
          The footer clears the home indicator on a gesture-navigation phone,
          where the bottom 34px of the viewport is not reliably tappable.
        */}
        {footer ? (
          <footer className="border-t border-slate-200 px-4 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4 sm:pb-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Labelled field wrapper with inline validation message. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  /** Marks the label. The control still carries its own `required`. */
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label">
        {label}
        {required ? (
          <span className="ml-0.5 text-rose-500" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
