"use client";

import { useEffect } from "react";
import { openPrintSheet } from "@/components/bills/print-transport";

/**
 * Print island for the bill page.
 *
 * Two modes, one tiny component, so the bill page itself stays a server
 * component:
 *   - `asButton`  renders a manual "Print bill" button.
 *   - default     fires the print dialog once on mount, used by ?print=1 so
 *                 the POS goes straight from "Complete sale" to the printer.
 */
export function AutoPrint({
  asButton = false,
  label = "Print bill",
}: {
  asButton?: boolean;
  /** What the button says. A credit note is not a bill. */
  label?: string;
}) {
  useEffect(() => {
    if (asButton) return;

    // One frame's delay lets fonts and layout settle, otherwise the print
    // preview can capture a half-styled page.
    const timer = setTimeout(() => openPrintSheet(label), 350);
    return () => clearTimeout(timer);
  }, [asButton, label]);

  if (!asButton) return null;

  return (
    <button type="button" onClick={() => openPrintSheet(label)} className="btn-primary">
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
      {label}
    </button>
  );
}
