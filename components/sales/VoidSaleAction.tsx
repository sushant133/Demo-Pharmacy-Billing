"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

/**
 * Shaped by hand rather than imported from lib/sales, which would pull the
 * Mongoose models into the browser bundle behind a type-only import.
 */
interface VoidResult {
  billNo: string;
  restored: Array<{ batchNumber: string; quantity: number }>;
  unreturned: Array<{ batchNumber: string; quantity: number }>;
}

/**
 * Void control for one bill.
 *
 * Voiding moves stock and rewrites the day's takings, so it asks for a
 * deliberate confirmation and a written reason - the same shape as cancelling
 * a GRN, and enforced by the API rather than only here.
 */
export function VoidSaleAction({
  saleId,
  billNo,
  units,
}: {
  saleId: string;
  billNo: string;
  units: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);

    const result = await apiFetch<VoidResult>(`/api/sales/${saleId}/void`, {
      method: "POST",
      json: { reason: reason.trim() },
    });

    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }

    // A lot on a bill should be undeletable, so this is close to impossible -
    // but if it happens the units are not back on any shelf, and saying so is
    // the only way the shop can correct the count.
    if (result.data.unreturned.length > 0) {
      const lots = result.data.unreturned
        .map((entry) => `${entry.batchNumber} (${entry.quantity})`)
        .join(", ");
      setWarning(
        `Voided, but these lots no longer exist so their units could not be returned: ${lots}. Correct the stock manually.`,
      );
    }

    setConfirming(false);
    setBusy(false);
    router.refresh();
  }

  if (warning) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      >
        {warning}
      </div>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full text-xs font-medium text-rose-600 hover:underline"
      >
        Void this bill
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
        <p className="text-xs text-rose-800">
          Voiding {billNo} returns {units} unit{units === 1 ? "" : "s"} to the
          batches they were dispensed from and removes the bill from takings,
          profit and stock alerts. The bill stays on record and keeps its number.
        </p>

        <label htmlFor="void-reason" className="label mt-3">
          Reason
        </label>
        <input
          id="void-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. customer returned everything unopened"
          className="input text-xs"
        />

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy || reason.trim().length < 3}
            className="btn-danger flex-1 py-1.5 text-xs"
          >
            {busy ? "Voiding…" : "Void bill"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="btn-secondary py-1.5 text-xs"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
