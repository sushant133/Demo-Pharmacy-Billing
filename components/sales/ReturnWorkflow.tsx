"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatExpiry, money } from "@/lib/format";
import { describeQuantity, formatUnitCount, stripLabel, unitWord } from "@/lib/pack";
import {
  CONDITION_CHECKS,
  REFUND_METHOD_LABELS,
  RETURN_REASONS,
  defaultRefundMethod,
  refundMethodsFor,
  type RefundMethodCode,
  type ReturnReasonCode,
} from "@/lib/return-eligibility";
import { Badge, cx } from "@/components/ui";

/**
 * Steps 2 to 6 of the counter's return: pick the medicine, say how many, say
 * why, read the refund, confirm.
 *
 * The bill has already been found by the page behind this, so everything here
 * is about one invoice. Eligibility was decided on the server and arrives with
 * each line: an expired or already-returned line is shown greyed with the
 * reason rather than hidden, because "why can't I return this?" is the
 * question a customer is asking at the counter while this is on screen.
 *
 * The refund figure is worked out here only to show it. What is actually
 * credited is recomputed by the server from the bill, so the number on the
 * screen can never quietly disagree with the number in the books.
 */

export interface ReturnableLine {
  lineIndex: number;
  medicineName: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  alreadyReturned: number;
  returnable: number;
  unitPrice: number;
  unit: string;
  unitsPerStrip: number;
  eligible: boolean;
  /** Why not, when it is not. */
  message: string;
}

interface ReturnResult {
  billNo: string;
  returnIndex: number;
  units: number;
  totalAmount: number;
  restored: Array<{ batchNumber: string; quantity: number }>;
  unreturned: Array<{ batchNumber: string; quantity: number }>;
}

export function ReturnWorkflow({
  saleId,
  billNo,
  lines,
  /** Share of the bill's discount and VAT, used for the preview only. */
  discountRate,
  vatRate,
  /** Still owed on this bill, which decides whether "reduce what they owe" is offered. */
  outstanding,
}: {
  saleId: string;
  billNo: string;
  lines: ReturnableLine[];
  discountRate: number;
  vatRate: number;
  outstanding: number;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode | "">("");
  const [note, setNote] = useState("");
  const [condition, setCondition] = useState(false);
  const methods = refundMethodsFor(outstanding);
  const [refundMethod, setRefundMethod] = useState<RefundMethodCode>(
    defaultRefundMethod(outstanding),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReturnResult | null>(null);
  const inflight = useRef(false);

  const eligible = lines.filter((line) => line.eligible);
  const blocked = lines.filter((line) => !line.eligible);

  const chosen = useMemo(
    () =>
      eligible
        .map((line) => ({
          line,
          quantity: Math.max(0, Math.floor(Number(qty[line.lineIndex] || 0))),
        }))
        .filter((entry) => entry.quantity > 0),
    [eligible, qty],
  );

  // Step 5, live: the same arithmetic the server will redo. A line's share of
  // the bill's discount is its share of the subtotal, and VAT follows the
  // discounted figure - so a refund on a discounted bill gives back what was
  // actually paid, not the shelf price.
  const refund = useMemo(() => {
    const gross = chosen.reduce(
      (sum, { line, quantity }) => sum + line.unitPrice * quantity,
      0,
    );
    const discount = gross * discountRate;
    const taxable = gross - discount;
    const vat = taxable * vatRate;
    const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
    return {
      units: chosen.reduce((sum, entry) => sum + entry.quantity, 0),
      gross: round(gross),
      discount: round(discount),
      taxable: round(taxable),
      vat: round(vat),
      total: round(taxable + vat),
    };
  }, [chosen, discountRate, vatRate]);

  const noteRequired = reasonCode === "other";
  const ready =
    chosen.length > 0 &&
    reasonCode !== "" &&
    condition &&
    (!noteRequired || note.trim().length >= 3);

  function setLineQty(line: ReturnableLine, value: number) {
    const next = Math.max(0, Math.min(line.returnable, Math.floor(value) || 0));
    setQty((current) => ({
      ...current,
      [line.lineIndex]: next === 0 ? "" : String(next),
    }));
  }

  async function submit() {
    if (inflight.current || !ready) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const chosenReason =
      RETURN_REASONS.find((entry) => entry.code === reasonCode)?.label ?? "Return";

    const result = await apiFetch<ReturnResult>(`/api/sales/${saleId}/return`, {
      method: "POST",
      json: {
        items: chosen.map(({ line, quantity }) => ({
          lineIndex: line.lineIndex,
          quantity,
        })),
        reasonCode,
        // The stored reason reads on its own in the history, without having to
        // look the code up: the chosen label, plus whatever was typed.
        reason: note.trim() ? `${chosenReason} — ${note.trim()}` : chosenReason,
        conditionConfirmed: condition,
        refundMethod,
      },
    });

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      setConfirming(false);
      return;
    }

    setDone(result.data);
    router.refresh();
  }

  // ---- Step 6 done: receipt and what happened ----------------------------
  if (done) {
    return (
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              Return recorded against {done.billNo}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              {formatUnitCount(done.units, "unit")} back on the shelf ·{" "}
              <span className="tnum font-semibold text-slate-900">
                {money(done.totalAmount)}
              </span>{" "}
              refunded
            </p>
          </div>
        </div>

        {done.unreturned.length > 0 ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            The refund went through, but these lots no longer exist so their
            units could not go back on the shelf:{" "}
            {done.unreturned
              .map((entry) => `${entry.batchNumber} (${entry.quantity})`)
              .join(", ")}
            . Correct the stock by hand.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={`/returns/${saleId}/${done.returnIndex}?print=1`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
          >
            Print return receipt
          </a>
          <Link href={`/sales/${saleId}`} className="btn-secondary">
            View invoice
          </Link>
          <button
            type="button"
            onClick={() => {
              setDone(null);
              setQty({});
              setReasonCode("");
              setNote("");
              setCondition(false);
            }}
            className="btn-secondary"
          >
            Another return
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-100">
      {/* ---- Step 2: choose the medicine, Step 3: how many ---- */}
      <div className="p-4 sm:p-5">
        <StepHeading step={2}>Select medicine and quantity</StepHeading>

        {eligible.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Nothing on this bill can be taken back.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {eligible.map((line) => {
              const perStrip = line.unitsPerStrip || 1;
              const typed = Math.max(0, Math.floor(Number(qty[line.lineIndex] || 0)));
              const pack = stripLabel(perStrip, line.unit);
              return (
                <li
                  key={line.lineIndex}
                  className={cx(
                    "rounded-lg border px-3 py-2.5 transition-colors",
                    typed > 0
                      ? "border-brand-200 bg-brand-50/40"
                      : "border-slate-200 bg-slate-50/60",
                  )}
                >
                  {/*
                    The checkbox is the fast path, not a second control: most
                    returns are "all of this line", and ticking it fills the
                    quantity with everything returnable. Unticking clears it.
                    The stepper below stays for the partial case, and moving it
                    off zero ticks the box back on, so the two can never
                    disagree about whether this line is coming back.
                  */}
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={typed > 0}
                      onChange={(event) =>
                        setLineQty(line, event.target.checked ? line.returnable : 0)
                      }
                      aria-label={`Return ${line.medicineName}`}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-brand-600"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <p className="text-sm font-medium text-slate-900">
                          {line.medicineName}
                        </p>
                        <p className="tnum text-xs text-slate-500">
                          {money(line.unitPrice)} each
                        </p>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        <span className="font-mono">{line.batchNumber}</span> · exp{" "}
                        {formatExpiry(line.expiryDate)}
                        {pack ? ` · ${pack}` : ""}
                      </p>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Sold {formatUnitCount(line.quantity, line.unit)}
                    {line.alreadyReturned > 0
                      ? ` · ${formatUnitCount(line.alreadyReturned, line.unit)} already back`
                      : ""}
                    {" · "}
                    {formatUnitCount(line.returnable, line.unit)} returnable
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex items-center rounded-xl bg-white ring-1 ring-slate-200 ring-inset">
                      <button
                        type="button"
                        aria-label={`Fewer ${line.medicineName}`}
                        onClick={() => setLineQty(line, typed - 1)}
                        className="px-2.5 py-1 text-slate-500 hover:text-slate-900"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={line.returnable}
                        step={1}
                        value={qty[line.lineIndex] ?? ""}
                        onChange={(event) =>
                          setQty((current) => ({
                            ...current,
                            [line.lineIndex]: event.target.value,
                          }))
                        }
                        onBlur={(event) => setLineQty(line, Number(event.target.value))}
                        placeholder="0"
                        aria-label={`How many ${unitWord(line.unit, 2)} of ${line.medicineName} to return`}
                        className="tnum w-14 border-0 bg-transparent py-1 text-center text-sm font-semibold focus:ring-0 focus:outline-none"
                      />
                      <button
                        type="button"
                        aria-label={`More ${line.medicineName}`}
                        onClick={() => setLineQty(line, typed + 1)}
                        className="px-2.5 py-1 text-slate-500 hover:text-slate-900"
                      >
                        +
                      </button>
                    </div>

                    {perStrip > 1 && line.returnable >= perStrip ? (
                      <button
                        type="button"
                        onClick={() => setLineQty(line, typed + perStrip)}
                        className="rounded-md bg-white px-1.5 py-1 text-[10px] font-medium text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-50"
                      >
                        + 1 strip ({perStrip})
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => setLineQty(line, line.returnable)}
                      className="rounded-md bg-white px-1.5 py-1 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50"
                    >
                      All {line.returnable}
                    </button>

                    {typed > 0 ? (
                      <span className="tnum ml-auto text-sm font-semibold text-slate-900">
                        {money(line.unitPrice * typed)}
                      </span>
                    ) : null}
                  </div>

                  {typed > 0 ? (
                    <p className="mt-1.5 text-xs text-slate-600">
                      {describeQuantity(typed, perStrip, line.unit)} coming back
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {/*
          Shown, not hidden. A line the counter cannot take back is exactly
          what the customer is asking about, and "it isn't on the list" is no
          answer to give them.
        */}
        {blocked.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {blocked.map((line) => (
              <li
                key={line.lineIndex}
                className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-slate-200 bg-white px-3 py-2 opacity-75"
              >
                <span className="text-sm text-slate-500 line-through">
                  {line.medicineName}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {line.batchNumber}
                </span>
                <Badge tone="slate" className="ml-auto">
                  Not returnable
                </Badge>
                <p className="w-full text-[11px] text-slate-500">{line.message}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ---- Step 4: why, and the condition check ---- */}
      <div className="p-4 sm:p-5">
        <StepHeading step={4}>Reason and condition</StepHeading>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="reason-code" className="label">
              Reason for return
            </label>
            <select
              id="reason-code"
              value={reasonCode}
              onChange={(event) =>
                setReasonCode(event.target.value as ReturnReasonCode | "")
              }
              className="input"
            >
              <option value="">Choose a reason…</option>
              {RETURN_REASONS.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="reason-note" className="label">
              Note{" "}
              <span className="font-normal text-slate-400">
                {noteRequired ? "required" : "optional"}
              </span>
            </label>
            <input
              id="reason-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={240}
              placeholder="Anything the next person should know"
              className="input"
            />
          </div>
        </div>

        {/*
          The physical check. Listed rather than summarised as "in good
          condition", which is a question people tick through without looking.
        */}
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={condition}
              onChange={(event) => setCondition(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600"
            />
            <span className="min-w-0">
              <span className="text-sm font-medium text-slate-900">
                I have checked this medicine and it can be sold again
              </span>
              <ul className="mt-1.5 space-y-0.5">
                {CONDITION_CHECKS.map((check) => (
                  <li
                    key={check}
                    className="flex items-start gap-1.5 text-xs text-slate-600"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                    {check}
                  </li>
                ))}
              </ul>
            </span>
          </label>

          <p className="mt-2.5 border-t border-slate-200 pt-2.5 text-[11px] text-slate-500">
            Opened, damaged, tampered or expired medicine cannot go back on the
            shelf. Write it off under{" "}
            <Link href="/inventory/damaged" className="text-brand-700 hover:underline">
              damaged stock
            </Link>{" "}
            instead.
          </p>
        </div>
      </div>

      {/* ---- Step 5: how the money goes back ---- */}
      <div className="p-4 sm:p-5">
        <StepHeading step={5}>How the refund is given</StepHeading>

        {/*
          Radio cards rather than a select: there are three options at most,
          each needs a line of explanation, and this is the one choice on the
          screen that decides whether cash leaves the drawer.
        */}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {methods.map((method) => {
            const active = refundMethod === method.code;
            return (
              <label
                key={method.code}
                className={cx(
                  "cursor-pointer rounded-lg border p-3 transition-colors",
                  active
                    ? "border-brand-300 bg-brand-50/60 ring-1 ring-brand-200"
                    : "border-slate-200 bg-white hover:bg-slate-50",
                )}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="refund-method"
                    value={method.code}
                    checked={active}
                    onChange={() => setRefundMethod(method.code)}
                    className="mt-0.5 h-4 w-4 shrink-0 border-slate-300 text-brand-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">
                      {method.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {method.hint}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {outstanding > 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            This bill still has{" "}
            <span className="tnum font-medium text-amber-700">
              {money(outstanding)}
            </span>{" "}
            outstanding.
          </p>
        ) : null}
      </div>

      {/* ---- Step 6: read the summary, confirm ---- */}
      <div className="bg-slate-50/60 p-4 sm:p-5">
        <StepHeading step={6}>Check and confirm</StepHeading>

        <dl className="mt-3 space-y-1.5">
          <Row label="Items" value={`${refund.units} unit${refund.units === 1 ? "" : "s"}`} />
          <Row label="Value" value={money(refund.gross)} />
          {refund.discount > 0 ? (
            <Row
              label="Less discount given"
              value={`− ${money(refund.discount)}`}
              className="text-rose-600"
            />
          ) : null}
          <Row label={`VAT (${Math.round(vatRate * 100)}%)`} value={money(refund.vat)} />
          <div className="border-t border-slate-200 pt-1.5">
            <Row label="Refund due" value={money(refund.total)} strong />
          </div>
        </dl>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
          >
            {error}
          </p>
        ) : null}

        {confirming ? (
          <div className="mt-3 rounded-lg border border-brand-200 bg-white p-3">
            <p className="text-sm font-medium text-slate-900">
              Refund {money(refund.total)} and put{" "}
              {formatUnitCount(refund.units, "unit")} back on the shelf?
            </p>

            {/*
              The whole return, restated, on the step that commits it. Until
              now the medicines were three sections up the page and the reason
              two - so the last thing anyone saw before pressing the button was
              a total, which is the one part nobody gets wrong. This is the
              chance to notice the wrong strip was ticked.
            */}
            <ul className="mt-2.5 divide-y divide-slate-100 border-y border-slate-100">
              {chosen.map(({ line, quantity }) => (
                <li
                  key={line.lineIndex}
                  className="flex items-baseline justify-between gap-3 py-1.5"
                >
                  <span className="min-w-0 text-xs text-slate-700">
                    <span className="font-medium text-slate-900">
                      {formatUnitCount(quantity, line.unit)}
                    </span>{" "}
                    {line.medicineName}
                    <span className="ml-1 font-mono text-[10px] text-slate-400">
                      {line.batchNumber}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-xs font-medium text-slate-700">
                    {money(line.unitPrice * quantity)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-2.5 space-y-1">
              <SummaryRow
                label="Reason"
                value={
                  RETURN_REASONS.find((entry) => entry.code === reasonCode)
                    ?.label ?? "—"
                }
              />
              {note.trim() ? (
                <SummaryRow label="Note" value={note.trim()} />
              ) : null}
              <SummaryRow
                label="Refund given as"
                value={REFUND_METHOD_LABELS[refundMethod]}
              />
              <SummaryRow label="Condition checked" value="Yes" />
            </dl>

            <p className="mt-2.5 text-xs text-slate-500">
              {billNo} will be updated and a return receipt issued. This cannot
              be undone.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="btn-secondary flex-1"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="btn-primary flex-[2]"
              >
                {busy ? "Recording…" : "Confirm return"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!ready}
              className="btn-primary mt-3 w-full py-2.5"
            >
              Confirm return · {money(refund.total)}
            </button>
            {!ready ? (
              <p className="mt-1.5 text-center text-[11px] text-slate-500">
                {chosen.length === 0
                  ? "Choose a medicine and quantity above."
                  : reasonCode === ""
                    ? "Choose a reason for the return."
                    : noteRequired && note.trim().length < 3
                      ? "Add a note explaining the reason."
                      : "Confirm the condition check above."}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function StepHeading({ step, children }: { step: number; children: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-800">
        {step}
      </span>
      <h2 className="text-sm font-semibold text-slate-900">{children}</h2>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center justify-between text-sm", className)}>
      <dt className={strong ? "font-semibold text-slate-900" : "text-slate-600"}>
        {label}
      </dt>
      <dd className={cx("tnum", strong ? "font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}

/** A label/value line in the confirmation summary. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-slate-800">
        {value}
      </dd>
    </div>
  );
}
