"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/lib/constants";
import { money } from "@/lib/format";
import { Field, SlideOver } from "@/components/SlideOver";
import { cx } from "@/components/ui";

/**
 * Collect money against an outstanding bill.
 *
 * The API for this has existed since the payment ledger landed; nothing in the
 * UI ever called it, so a credit invoice could be raised and then never
 * settled from anywhere in the app. This is that missing half.
 *
 * The panel never edits a balance - it appends a receipt - so the shape of the
 * form is the shape of the receipt: how much, how it arrived, and the cheque
 * or transaction number somebody will later be asked to produce.
 */

/** Hand-written rather than imported, so lib/sales stays out of the bundle. */
interface ReceivedPayment {
  billNo: string;
  totalDue: number;
  paid: number;
  remaining: number;
  status: "paid" | "partial" | "unpaid";
}

/**
 * Credit is how a bill goes unpaid, so it cannot also be how one is settled.
 * The API rejects it too; offering it here would only be a trap.
 */
const RECEIPT_METHODS = PAYMENT_MODES.filter((mode) => mode !== "credit");

export function RecordPaymentDialog({
  saleId,
  billNo,
  customerName,
  outstanding,
  total,
  received,
  variant = "button",
  label = "Record payment",
}: {
  saleId: string;
  billNo: string;
  customerName?: string;
  /** What is still owed, as the server last computed it. */
  outstanding: number;
  total: number;
  received: number;
  /** `link` for a table row; `button` for a detail panel. */
  variant?: "button" | "link";
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMode>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReceivedPayment | null>(null);
  const inflight = useRef(false);

  const typed = Number(amount);
  const valid =
    amount.trim() !== "" &&
    Number.isFinite(typed) &&
    typed > 0 &&
    // Half a paisa of slack, so a full settlement typed by hand is never
    // rejected for a rounding difference the customer cannot pay.
    typed <= outstanding + 0.005;

  function start() {
    // Prefilled with the balance: settling in full is what happens most of the
    // time, and it is the one figure nobody should have to read off and retype.
    setAmount(outstanding.toFixed(2));
    setMethod("cash");
    setReference("");
    setNote("");
    setError(null);
    setDone(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    // A receipt was taken, so the list and the badges behind the panel are now
    // stale. Refreshing on close rather than on success keeps the confirmation
    // on screen long enough to read.
    if (done) router.refresh();
  }

  async function submit() {
    if (inflight.current || !valid) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch<ReceivedPayment>(
      `/api/sales/${saleId}/payments`,
      {
        method: "POST",
        json: {
          amount: Number(typed.toFixed(2)),
          method,
          reference: reference.trim() || undefined,
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

    setDone(result.data);
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        className={
          variant === "button"
            ? "btn-primary w-full"
            : "text-xs font-medium text-emerald-700 hover:underline"
        }
      >
        {label}
      </button>

      {open ? (
        <SlideOver
          title={done ? "Payment recorded" : "Record a payment"}
          description={`${billNo}${customerName ? ` · ${customerName}` : ""}`}
          onClose={close}
          footer={
            done ? (
              <button type="button" onClick={close} className="btn-primary w-full">
                Done
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy || !valid}
                  className="btn-primary flex-1"
                >
                  {busy ? "Recording…" : `Receive ${money(valid ? typed : 0)}`}
                </button>
                <button type="button" onClick={close} className="btn-secondary">
                  Cancel
                </button>
              </div>
            )
          }
        >
          {done ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-sm font-semibold text-emerald-900">
                  {money(typed)} received against {done.billNo}.
                </p>
                <p className="mt-1 text-xs text-emerald-800">
                  {done.remaining > 0
                    ? `${money(done.remaining)} is still outstanding on this invoice.`
                    : "This invoice is now settled in full."}
                </p>
              </div>

              <dl className="space-y-2 text-sm">
                <Line label="Invoice total" value={money(done.totalDue)} />
                <Line label="Received in all" value={money(done.paid)} />
                <Line label="Still outstanding" value={money(done.remaining)} strong />
              </dl>
            </div>
          ) : (
            <div className="space-y-4">
              {error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                >
                  {error}
                </div>
              ) : null}

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dl className="space-y-1.5 text-sm">
                  <Line label="Invoice total" value={money(total)} />
                  <Line label="Received so far" value={money(received)} />
                  <Line label="Outstanding" value={money(outstanding)} strong />
                </dl>
              </div>

              <Field
                label="Amount received"
                htmlFor="receipt-amount"
                hint={`Up to ${money(outstanding)}. A part payment is fine - the balance stays on the invoice.`}
                error={
                  amount.trim() !== "" && !valid
                    ? `Enter an amount between Rs 0.01 and ${money(outstanding)}.`
                    : undefined
                }
              >
                <div className="flex gap-2">
                  <input
                    id="receipt-amount"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    max={outstanding}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    className="input tnum"
                  />
                  <button
                    type="button"
                    onClick={() => setAmount(outstanding.toFixed(2))}
                    className="btn-secondary shrink-0 px-3 text-xs"
                  >
                    Full balance
                  </button>
                </div>
              </Field>

              <Field label="How it was received" htmlFor="receipt-method">
                <select
                  id="receipt-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as PaymentMode)}
                  className="input"
                >
                  {RECEIPT_METHODS.map((mode) => (
                    <option key={mode} value={mode}>
                      {PAYMENT_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Reference"
                htmlFor="receipt-reference"
                hint="Cheque number, wallet transaction id, or similar. Optional."
              >
                <input
                  id="receipt-reference"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  maxLength={120}
                  placeholder="e.g. NIC-4412098"
                  className="input"
                />
              </Field>

              <Field label="Note" htmlFor="receipt-note" hint="Optional.">
                <textarea
                  id="receipt-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={300}
                  rows={2}
                  placeholder="e.g. collected by the delivery rider"
                  className="input"
                />
              </Field>
            </div>
          )}
        </SlideOver>
      ) : null}
    </>
  );
}

function Line({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd
        className={cx(
          "tnum text-right",
          strong ? "font-semibold text-slate-900" : "font-medium text-slate-700",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
