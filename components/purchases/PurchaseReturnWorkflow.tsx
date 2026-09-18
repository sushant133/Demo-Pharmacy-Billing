"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import {
  PURCHASE_RETURN_REASONS,
  type PurchaseIneligibleReason,
} from "@/lib/purchase-return";
import { Badge, Card, cx } from "@/components/ui";

/**
 * Sending goods back to the supplier, on one screen.
 *
 * The counterpart of ReturnWorkflow, and shaped the same way: the person
 * holding the box picks what is going back, says why, reads what the shop will
 * be credited, and confirms - without being sent to another page for the
 * middle of it.
 *
 * What differs is the direction of the risk. A customer return puts units on a
 * shelf, so the question is whether they are fit to sell. This takes units
 * *off* a shelf, so the question is whether they are still there at all: a lot
 * the counter has been dispensing all morning may no longer hold what the
 * delivery note says. `returnable` is therefore the smaller of what the
 * invoice allows and what the lot physically holds, computed on the server and
 * re-checked inside the transaction.
 */

export interface ReturnablePurchaseLine {
  lineIndex: number;
  medicineName: string;
  batchNumber: string;
  /** Billed plus free - what actually arrived. */
  receivedQuantity: number;
  alreadyReturned: number;
  onHandQuantity: number;
  unitCost: number;
  /** The most that can go back right now. 0 when the line is closed. */
  returnable: number;
  ineligibleReason: PurchaseIneligibleReason | null;
  ineligibleLabel: string;
}

export function PurchaseReturnWorkflow({
  purchaseId,
  grnNo,
  supplierName,
  lines,
  canRecord,
}: {
  purchaseId: string;
  grnNo: string;
  supplierName: string;
  lines: ReturnablePurchaseLine[];
  canRecord: boolean;
}) {
  const router = useRouter();

  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reason, setReason] = useState("");
  const [creditNoteNo, setCreditNoteNo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ units: number; total: number } | null>(null);
  const inflight = useRef(false);

  const eligible = lines.filter((line) => line.returnable > 0);

  const selected = useMemo(
    () =>
      lines
        .map((line) => ({ line, quantity: quantities[line.lineIndex] ?? 0 }))
        .filter((row) => row.quantity > 0),
    [lines, quantities],
  );

  const credit = useMemo(
    () =>
      selected.reduce(
        (sum, row) => sum + row.quantity * row.line.unitCost,
        0,
      ),
    [selected],
  );

  const units = selected.reduce((sum, row) => sum + row.quantity, 0);
  const ready = selected.length > 0 && reasonCode !== "" && reason.trim().length >= 3;

  function setQuantity(line: ReturnablePurchaseLine, raw: number) {
    const clamped = Math.max(0, Math.min(line.returnable, Math.floor(raw || 0)));
    setQuantities((current) => ({ ...current, [line.lineIndex]: clamped }));
  }

  async function submit() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch<{ units: number; totalAmount: number }>(
      `/api/purchases/${purchaseId}/return`,
      {
        method: "POST",
        json: {
          items: selected.map((row) => ({
            lineIndex: row.line.lineIndex,
            quantity: row.quantity,
          })),
          reasonCode,
          reason: reason.trim(),
          creditNoteNo: creditNoteNo.trim(),
        },
      },
    );

    inflight.current = false;
    setBusy(false);
    setConfirming(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setDone({ units: result.data.units, total: result.data.totalAmount });
    setQuantities({});
    setReason("");
    setCreditNoteNo("");
    setReasonCode("");
    router.refresh();
  }

  if (done) {
    return (
      <Card className="p-6">
        <Badge tone="green">Debit note raised</Badge>
        <p className="mt-3 text-sm text-slate-700">
          {done.units} unit(s) went back to {supplierName} against {grnNo}. What
          you owe them has fallen by{" "}
          <span className="font-semibold">{money(done.total)}</span>.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          The stock has left the shelf and the supplier ledger is already
          updated. Record their credit note number against this delivery when it
          arrives.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setDone(null)}
            className="btn-secondary"
          >
            Send more back
          </button>
          <a href={`/purchases/${purchaseId}`} className="btn-primary">
            Open the delivery
          </a>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card className="mb-4 overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
          <p className="text-sm font-semibold text-slate-900">
            What is going back
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            A line can only send back what is still on the shelf - units already
            dispensed are with a patient.
          </p>
        </div>

        <div className="table-scroll table-scroll-shadow table-pin-first">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr>
                <th className="th">Medicine</th>
                <th className="th">Lot</th>
                <th className="th text-right">Received</th>
                <th className="th text-right">On shelf</th>
                <th className="th text-right">Unit cost</th>
                <th className="th text-right">Can go back</th>
                <th className="th text-right">Returning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line) => {
                const value = quantities[line.lineIndex] ?? 0;
                const closed = line.returnable === 0;

                return (
                  <tr
                    key={line.lineIndex}
                    className={cx(closed ? "bg-slate-50/60" : "hover:bg-slate-50")}
                  >
                    <td className="td font-medium text-slate-900">
                      {line.medicineName}
                      {closed ? (
                        <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                          {line.ineligibleLabel}
                        </span>
                      ) : null}
                    </td>
                    <td className="td font-mono text-xs text-slate-600">
                      {line.batchNumber}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {line.receivedQuantity}
                      {line.alreadyReturned > 0 ? (
                        <span className="block text-[11px] text-amber-700">
                          {line.alreadyReturned} back
                        </span>
                      ) : null}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {line.onHandQuantity}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {money(line.unitCost)}
                    </td>
                    <td className="td tnum text-right font-medium text-slate-900">
                      {line.returnable}
                    </td>
                    <td className="td text-right">
                      {closed ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          <input
                            type="number"
                            min={0}
                            max={line.returnable}
                            value={value || ""}
                            onChange={(event) =>
                              setQuantity(line, Number(event.target.value))
                            }
                            aria-label={`Units of ${line.medicineName} going back`}
                            className="input tnum w-20 py-1 text-right"
                          />
                          <button
                            type="button"
                            onClick={() => setQuantity(line, line.returnable)}
                            className="btn-ghost px-2 py-1 text-[11px]"
                          >
                            All
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {eligible.length === 0 ? (
        <Card className="p-5">
          <p className="text-sm text-slate-600">
            Nothing on {grnNo} can go back. Either it has all been returned
            already, or the stock has been dispensed.
          </p>
        </Card>
      ) : (
        <Card className="p-4 sm:p-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <label
                htmlFor="pr-reason-code"
                className="label"
              >
                Why are they going back? <span className="text-rose-600">*</span>
              </label>
              <select
                id="pr-reason-code"
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
                className="input"
              >
                <option value="">Choose a reason…</option>
                {PURCHASE_RETURN_REASONS.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label}
                  </option>
                ))}
              </select>

              <label htmlFor="pr-reason" className="label mt-3">
                Details <span className="text-rose-600">*</span>
              </label>
              <input
                id="pr-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. three strips crushed in the carton"
                className="input"
              />

              <label htmlFor="pr-credit" className="label mt-3">
                Their credit note number
              </label>
              <input
                id="pr-credit"
                value={creditNoteNo}
                onChange={(event) => setCreditNoteNo(event.target.value)}
                placeholder="Leave blank until they issue one"
                className="input"
              />
            </div>

            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                This debit note
              </p>
              <p className="tnum mt-2 text-3xl font-semibold text-slate-900">
                {money(credit)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {units} unit(s) across {selected.length} line(s). This comes off
                what you owe {supplierName} — it is not a refund to chase.
              </p>

              {error ? (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                >
                  {error}
                </div>
              ) : null}

              {!canRecord ? (
                <p className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  Your role cannot send goods back. Ask whoever posts deliveries.
                </p>
              ) : confirming ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs text-amber-900">
                    {units} unit(s) will leave the shelf and {supplierName} will
                    be debited {money(credit)}. This cannot be undone — a
                    mistake is corrected by receiving the goods back in.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={submit}
                      disabled={busy}
                      className="btn-primary flex-1 py-1.5 text-xs"
                    >
                      {busy ? "Working…" : "Confirm return"}
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
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!ready}
                  className="btn-primary mt-3 w-full"
                >
                  Review this return
                </button>
              )}
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
