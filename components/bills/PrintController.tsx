"use client";

import { useEffect, useRef, useState } from "react";
import { encodeEscPos } from "@/lib/escpos";
import { formatThermalReceipt, type ThermalReceipt } from "@/lib/receipt-text";
import {
  canPrintToRoll,
  openPrintSheet,
  printToRoll,
} from "@/components/bills/print-transport";
import {
  BillDocument,
  type BillDocumentProps,
} from "@/components/bills/BillDocument";

/**
 * Records the original vs reprint, then sends the bill to paper.
 *
 * Desktop and Wi-Fi printers use the system print sheet, laid out by the
 * pharmacy's assigned template. A thermal roll can also be driven directly
 * over Bluetooth from Android Chrome and the Android app; `print-transport`
 * picks the route the current shell supports. Mobile browsers block print()
 * without a tap, so auto-print is desktop-only.
 *
 * The document is rendered here rather than by the page because the copy
 * label is live: the first print stamps the bill as the original and every
 * one after it increments a copy number, and the paper has to say which it
 * is at the moment it comes out, not what it was when the page loaded.
 */
export function PrintController({
  saleId,
  autoPrint = false,
  alreadyPrinted,
  reprintCount,
  escposColumns,
  receipt,
  document,
}: {
  saleId: string;
  autoPrint?: boolean;
  alreadyPrinted: boolean;
  reprintCount: number;
  /**
   * Characters per line on this shop's roll, or null when its template is
   * not a roll at all - a sheet printer has no ESC/POS route, so offering
   * the button would only produce a printer that never responds.
   */
  escposColumns: number | null;
  receipt: ThermalReceipt;
  document: Omit<BillDocumentProps, "copyLabel">;
}) {
  const [label, setLabel] = useState(
    alreadyPrinted
      ? reprintCount > 0
        ? `Copy of Original – ${reprintCount}`
        : "ORIGINAL"
      : "ORIGINAL",
  );
  const [busy, setBusy] = useState<"print" | "bt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bluetoothOk, setBluetoothOk] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    setBluetoothOk(escposColumns !== null && canPrintToRoll());
  }, [escposColumns]);

  async function recordPrint(): Promise<string> {
    const response = await fetch(`/api/sales/${saleId}/print`, { method: "POST" });
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { label?: string };
    };
    if (body.ok && body.data?.label) {
      setLabel(body.data.label);
      return body.data.label;
    }
    return label;
  }

  useEffect(() => {
    async function recordAndPrint() {
      const coarse =
        typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      try {
        await recordPrint();
      } catch {
        // Still print; the copy count may be stale.
      }
      if (coarse) return;
      window.setTimeout(() => openPrintSheet("Bill"), 150);
    }

    if (!autoPrint || started.current) return;
    started.current = true;
    void recordAndPrint();
  }, [autoPrint, saleId]);

  async function onPrintClick() {
    setError(null);
    setBusy("print");
    try {
      await recordPrint();
    } catch {
      // Still print.
    }
    window.setTimeout(() => {
      if (!openPrintSheet("Bill")) {
        setError(
          escposColumns !== null
            ? "This device has no print sheet. Use the Bluetooth printer button for the roll."
            : "This device has no print sheet. Open the bill on a computer to print it.",
        );
      }
      setBusy(null);
    }, 150);
  }

  async function onBluetoothClick() {
    if (escposColumns === null) return;
    setError(null);
    setBusy("bt");
    try {
      const nextLabel = await recordPrint();
      const payload = { ...receipt, copyLabel: nextLabel };
      await printToRoll(
        encodeEscPos(formatThermalReceipt(payload, escposColumns)),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach the Bluetooth printer.";
      if (message.toLowerCase().includes("cancel")) {
        setError(null);
      } else {
        setError(message);
      }
    }
    setBusy(null);
  }

  return (
    <>
      <div className="no-print receipt-print-actions">
        <button
          type="button"
          onClick={() => void onPrintClick()}
          disabled={busy !== null}
          className="btn-primary w-full"
        >
          {busy === "print" ? "Printing…" : "Print bill"}
        </button>
        {bluetoothOk ? (
          <button
            type="button"
            onClick={() => void onBluetoothClick()}
            disabled={busy !== null}
            className="btn-secondary w-full"
          >
            {busy === "bt" ? "Sending…" : "Bluetooth printer"}
          </button>
        ) : null}
        <p className="receipt-print-hint">
          {escposColumns !== null
            ? "Wi-Fi or USB printer: tap Print bill and pick it in the system sheet. Roll printer: tap Bluetooth printer and choose the till printer."
            : "Tap Print bill and pick the printer in the system sheet."}
        </p>
        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>

      <BillDocument
        {...document}
        copyLabel={label}
        copyIsReprint={label !== "ORIGINAL"}
      />
    </>
  );
}
