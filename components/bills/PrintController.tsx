"use client";

import { useEffect, useRef, useState } from "react";
import { encodeEscPos } from "@/lib/escpos";
import { formatThermalReceipt, type ThermalReceipt } from "@/lib/receipt-text";
import { canUseBluetoothPrinter, printViaBluetooth } from "@/components/bills/print-bluetooth";

/**
 * Records the original vs reprint, then sends the bill to paper.
 *
 * Desktop and Wi-Fi printers use the browser print sheet (80mm CSS).
 * Android Chrome can also talk to a Bluetooth ESC/POS printer directly.
 * Mobile browsers block print() without a tap, so auto-print is desktop-only.
 */
export function PrintController({
  saleId,
  autoPrint = false,
  alreadyPrinted,
  reprintCount,
  receipt,
}: {
  saleId: string;
  autoPrint?: boolean;
  alreadyPrinted: boolean;
  reprintCount: number;
  receipt: ThermalReceipt;
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
    setBluetoothOk(canUseBluetoothPrinter());
  }, []);

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
      window.setTimeout(() => window.print(), 150);
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
      window.print();
      setBusy(null);
    }, 150);
  }

  async function onBluetoothClick() {
    setError(null);
    setBusy("bt");
    try {
      const nextLabel = await recordPrint();
      const payload = { ...receipt, copyLabel: nextLabel };
      await printViaBluetooth(encodeEscPos(formatThermalReceipt(payload)));
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
      <p className={label === "ORIGINAL" ? "receipt-copy original" : "receipt-copy reprint"}>
        {label}
      </p>
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
          Phone + Wi-Fi printer: tap Print bill and pick the printer. Bluetooth
          80mm roll: tap Bluetooth printer (Android Chrome).
        </p>
        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}
