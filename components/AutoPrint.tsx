"use client";

import { useEffect } from "react";

/**
 * Print island for the bill page.
 *
 * Two modes, one tiny component, so the bill page itself stays a server
 * component:
 *   - `asButton`  renders a manual "Print bill" button.
 *   - default     fires the print dialog once on mount, used by ?print=1 so
 *                 the POS goes straight from "Complete sale" to the printer.
 */
export function AutoPrint({ asButton = false }: { asButton?: boolean }) {
  useEffect(() => {
    if (asButton) return;

    // One frame's delay lets fonts and layout settle, otherwise the print
    // preview can capture a half-styled page.
    const timer = setTimeout(() => window.print(), 350);
    return () => clearTimeout(timer);
  }, [asButton]);

  if (!asButton) return null;

  return (
    <button type="button" onClick={() => window.print()} className="btn-primary">
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 9V4h12v5M6 18H4v-6h16v6h-2M8 14h8v6H8v-6z"
        />
      </svg>
      Print bill
    </button>
  );
}
