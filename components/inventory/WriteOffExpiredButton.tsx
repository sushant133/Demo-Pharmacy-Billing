"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { integer, money } from "@/lib/format";

/**
 * Write off every expired lot on the shelf in one go.
 *
 * Two clicks, not a browser confirm(): the first states exactly what will
 * happen, the second does it. Each lot still gets its own "Expired" line in
 * the stock ledger, as if it had been written off by hand.
 */
export function WriteOffExpiredButton({ units }: { units: number }) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    const result = await apiFetch<{ lots: number; units: number; value: number; failed: string[] }>(
      "/api/inventory/expired",
      { method: "POST" },
    );
    setBusy(false);
    setArming(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    const { lots, units: removed, value, failed } = result.data;
    setMessage(
      `Wrote off ${integer(removed)} units from ${integer(lots)} lot${lots === 1 ? "" : "s"} (${money(value)} at cost).` +
        (failed.length > 0 ? ` ${failed.length} lot(s) changed meanwhile - try again.` : ""),
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {arming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-rose-700">
            Remove all {integer(units)} expired units from stock?
          </span>
          <button type="button" className="btn-danger" disabled={busy} onClick={() => void run()}>
            {busy ? "Writing off…" : "Yes, write off"}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setArming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn-secondary text-rose-700" onClick={() => setArming(true)}>
          Write off all expired
        </button>
      )}
      {message ? (
        <p role="status" className="text-xs text-slate-600">
          {message}
        </p>
      ) : null}
    </div>
  );
}
