"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Records the original vs reprint, then optionally opens the print dialog.
 *
 * IRD e-billing rules: the first paper is the original; every later print
 * must be labelled "Copy of Original – N". Opening the bill on screen does
 * not count as a print.
 */
export function PrintController({
  saleId,
  autoPrint = false,
  alreadyPrinted,
  reprintCount,
}: {
  saleId: string;
  autoPrint?: boolean;
  alreadyPrinted: boolean;
  reprintCount: number;
}) {
  const [label, setLabel] = useState(
    alreadyPrinted
      ? reprintCount > 0
        ? `Copy of Original – ${reprintCount}`
        : "ORIGINAL"
      : "ORIGINAL",
  );
  const started = useRef(false);

  useEffect(() => {
    async function recordAndPrint() {
      try {
        const response = await fetch(`/api/sales/${saleId}/print`, { method: "POST" });
        const body = (await response.json()) as {
          ok?: boolean;
          data?: { label?: string };
        };
        if (body.ok && body.data?.label) setLabel(body.data.label);
      } catch {
        // Still print; the copy count may be stale.
      }
      window.setTimeout(() => window.print(), 150);
    }

    if (!autoPrint || started.current) return;
    started.current = true;
    void recordAndPrint();
  }, [autoPrint, saleId]);

  async function onPrintClick() {
    try {
      const response = await fetch(`/api/sales/${saleId}/print`, { method: "POST" });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { label?: string };
      };
      if (body.ok && body.data?.label) setLabel(body.data.label);
    } catch {
      // Still print.
    }
    window.setTimeout(() => window.print(), 150);
  }

  return (
    <>
      <p className={label === "ORIGINAL" ? "receipt-copy original" : "receipt-copy reprint"}>
        {label}
      </p>
      <button
        type="button"
        onClick={() => void onPrintClick()}
        className="btn-primary no-print mt-1 mb-2 w-full"
      >
        Print bill
      </button>
    </>
  );
}
