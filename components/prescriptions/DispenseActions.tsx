"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { integer } from "@/lib/format";
import { Card, cx } from "@/components/ui";

/**
 * Handing a script over, and withdrawing one.
 *
 * Quantities are per line because that is how a script is actually filled: the
 * antibiotic goes out in full today and the inhaler when it comes back into
 * stock. A single total could not say which.
 *
 * Nothing here decides whether the hand-over is allowed - the server re-checks
 * every line against what is still outstanding and refuses the write if
 * another counter got there first. This only makes the common case quick.
 */

export interface DispensableLine {
  lineIndex: number;
  medicineName: string;
  dosage: string;
  prescribed: number;
  dispensed: number;
  remaining: number;
}

export function DispensePanel({
  prescriptionId,
  rxNo,
  lines,
}: {
  prescriptionId: string;
  rxNo: string;
  lines: DispensableLine[];
}) {
  const router = useRouter();
  const outstanding = lines.filter((line) => line.remaining > 0);

  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [billNo, setBillNo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const picked = outstanding
    .map((line) => ({ line, quantity: Number(quantities[line.lineIndex] ?? "") }))
    .filter(
      ({ line, quantity }) =>
        Number.isInteger(quantity) && quantity > 0 && quantity <= line.remaining,
    );

  const overdrawn = outstanding.some((line) => {
    const typed = Number(quantities[line.lineIndex] ?? "");
    return Number.isFinite(typed) && typed > line.remaining;
  });

  const units = picked.reduce((sum, entry) => sum + entry.quantity, 0);

  function fillAll() {
    setQuantities(
      Object.fromEntries(
        outstanding.map((line) => [line.lineIndex, String(line.remaining)]),
      ),
    );
  }

  async function submit() {
    if (inflight.current || picked.length === 0) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch(
      `/api/prescriptions/${prescriptionId}/dispense`,
      {
        method: "POST",
        json: {
          items: picked.map(({ line, quantity }) => ({
            lineIndex: line.lineIndex,
            quantity,
          })),
          billNo: billNo.trim() || undefined,
          note: note.trim() || undefined,
        },
      },
    );

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setQuantities({});
    setBillNo("");
    setNote("");
    router.refresh();
  }

  if (outstanding.length === 0) return null;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-slate-900">Dispense</h2>
      <p className="mt-1 mb-3 text-xs text-slate-600">
        What is being handed over now. The rest stays outstanding on {rxNo}.
      </p>

      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <ul className="space-y-2.5">
        {outstanding.map((line) => {
          const typed = Number(quantities[line.lineIndex] ?? "");
          const tooMany = Number.isFinite(typed) && typed > line.remaining;

          return (
            <li key={line.lineIndex} className="flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  {line.medicineName}
                </p>
                <p className="text-[11px] text-slate-500">
                  {integer(line.remaining)} of {integer(line.prescribed)} still to
                  give
                  {line.dosage ? ` · ${line.dosage}` : ""}
                </p>
              </div>
              <input
                type="number"
                min={0}
                max={line.remaining}
                step={1}
                aria-label={`Quantity of ${line.medicineName}`}
                value={quantities[line.lineIndex] ?? ""}
                onChange={(event) =>
                  setQuantities((current) => ({
                    ...current,
                    [line.lineIndex]: event.target.value,
                  }))
                }
                className={cx(
                  "input tnum w-20 shrink-0 text-right",
                  tooMany && "border-rose-400 focus:border-rose-500",
                )}
              />
            </li>
          );
        })}
      </ul>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
        <div>
          <label htmlFor="billNo" className="label">
            Bill no{" "}
            <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="billNo"
            value={billNo}
            onChange={(event) => setBillNo(event.target.value)}
            placeholder="INV-…"
            className="input font-mono text-xs"
          />
        </div>
        <div>
          <label htmlFor="dispense-note" className="label">
            Note <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="dispense-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="input"
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || picked.length === 0 || overdrawn}
          className="btn-primary flex-1"
        >
          {busy
            ? "Recording…"
            : units > 0
              ? `Dispense ${integer(units)} unit${units === 1 ? "" : "s"}`
              : "Dispense"}
        </button>
        <button type="button" onClick={fillAll} className="btn-secondary">
          Fill all
        </button>
      </div>

      {overdrawn ? (
        <p className="mt-2 text-xs text-rose-600">
          One of these is more than the prescription has left on it.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Withdraw a script.
 *
 * Two-step and reasoned, the same as voiding a bill: a cancelled script cannot
 * be dispensed against again, and a partly-filled one that was then withdrawn
 * is exactly the case somebody will ask about later.
 */
export function CancelPrescriptionAction({
  prescriptionId,
  rxNo,
  outstanding,
}: {
  prescriptionId: string;
  rxNo: string;
  outstanding: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  async function submit() {
    if (inflight.current || reason.trim().length < 3) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch(`/api/prescriptions/${prescriptionId}/cancel`, {
      method: "POST",
      json: { reason: reason.trim() },
    });

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setConfirming(false);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full text-xs font-medium text-rose-600 hover:underline"
      >
        Cancel this prescription
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
          Cancelling {rxNo} stops anything further being dispensed against it.
          {outstanding > 0
            ? ` ${integer(outstanding)} unit${outstanding === 1 ? "" : "s"} still outstanding will be written off the script.`
            : ""}{" "}
          What has already been handed over stays on the record.
        </p>

        <label htmlFor="cancel-reason" className="label mt-3">
          Reason
        </label>
        <input
          id="cancel-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. doctor revised the prescription"
          className="input text-xs"
        />

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy || reason.trim().length < 3}
            className="btn-danger flex-1 py-1.5 text-xs"
          >
            {busy ? "Cancelling…" : "Cancel prescription"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="btn-secondary py-1.5 text-xs"
          >
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}
