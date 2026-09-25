"use client";

import { useEffect, useRef } from "react";
import { formatExpiry, money } from "@/lib/format";
import { formatUnitCount } from "@/lib/pack";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import {
  PAYMENT_STATUS_LABELS,
  givesChange,
  settleSale,
} from "@/lib/sale-payment";
import { Badge, cx } from "@/components/ui";
import type { SalePlan } from "@/lib/sales";

/**
 * Step 10: the last look before the money moves.
 *
 * Completing a sale deducts stock and issues a bill number that cannot be
 * reused, so it gets one deliberate confirmation rather than happening on the
 * same click that finished typing a quantity. What is shown here is the plan
 * the server returned - the same numbers it is about to charge - not a
 * client-side re-computation that could quietly disagree with it.
 */
export function ConfirmSale({
  plan,
  customerName,
  customerPhone,
  paymentMode,
  amountReceived,
  outletName,
  cashierName,
  submitting,
  onConfirm,
  onCancel,
}: {
  plan: SalePlan;
  customerName: string;
  customerPhone: string;
  paymentMode: PaymentMode;
  /** What the customer handed over. 0 when the till was not told. */
  amountReceived: number;
  outletName: string;
  cashierName: string;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The dialog opens on the action it is asking about, so the primary button
  // takes focus: Enter confirms, Escape backs out, no reaching for the mouse.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, submitting]);

  // Settled with the same function the server uses, from the same figures the
  // checkout panel showed, so the confirmation cannot present a third opinion.
  const settlement = settleSale({
    totalAmount: plan.totalAmount,
    amountReceived,
  });
  const change = givesChange(paymentMode) ? settlement.change : 0;
  const units = plan.lines.reduce((sum, line) => sum + line.requestedQuantity, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => !submitting && onCancel()}
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-[1px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-sale-title"
        className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white pb-[var(--safe-bottom)] shadow-2xl sm:rounded-2xl sm:pb-0"
      >
        <div className="shrink-0 border-b border-slate-100 px-5 py-4">
          <h2 id="confirm-sale-title" className="text-base font-semibold text-slate-900">
            Confirm sale
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {outletName}
            <span className="mx-1.5 text-slate-300">·</span>
            {cashierName}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Section label="Customer">
            <p className="text-sm text-slate-900">
              {customerName.trim() || "Walk-in customer"}
            </p>
            {customerPhone.trim() ? (
              <p className="tnum text-xs text-slate-500">{customerPhone.trim()}</p>
            ) : null}
          </Section>

          <Section label={`Items (${plan.lines.length} lines · ${units} items)`}>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {plan.lines.map((line) => (
                <li
                  key={`${line.medicineId}:${line.requestedBatchId ?? "auto"}`}
                  className="px-3 py-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                      {line.medicineName}
                    </p>
                    <p className="tnum shrink-0 text-sm font-semibold text-slate-900">
                      {money(line.lineTotal)}
                    </p>
                  </div>
                  {line.picks.map((pick) => (
                    <p key={pick.batchId} className="tnum text-[11px] text-slate-500">
                      <span className="font-mono">{pick.batchNumber}</span>
                      {" · "}
                      {formatUnitCount(pick.quantity, line.unit)} × {money(pick.unitPrice)}
                      {" · exp "}
                      {formatExpiry(pick.expiryDate)}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </Section>

          <Section label="Total">
            <dl className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5">
              <Line term="Subtotal" value={money(plan.subtotal)} />
              {plan.discount > 0 ? (
                <Line
                  term={
                    plan.discountPercent > 0
                      ? `Discount (${plan.discountPercent}%)`
                      : "Discount"
                  }
                  value={`− ${money(plan.discount)}`}
                  tone="text-rose-600"
                />
              ) : null}
              <Line
                term={`VAT (${Math.round(plan.vatRate * 100)}%)`}
                value={money(plan.vatAmount)}
              />
              <div className="border-t border-slate-200 pt-1.5">
                <Line term="Grand total" value={money(plan.totalAmount)} strong />
              </div>
            </dl>
          </Section>

          <Section label="Payment">
            <dl className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5">
              <Line term="Method" value={PAYMENT_MODE_LABELS[paymentMode]} />
              <Line term="Total due" value={money(settlement.totalDue)} />
              <Line term="Paid" value={money(settlement.paid)} />
              <Line
                term="Remaining"
                value={money(settlement.remaining)}
                tone={settlement.remaining > 0 ? "text-amber-700" : undefined}
                strong={settlement.remaining > 0}
              />
              {change > 0 ? (
                <Line
                  term="Change to give"
                  value={money(change)}
                  tone="text-emerald-700"
                  strong
                />
              ) : null}
              <div className="flex items-center justify-between border-t border-slate-200 pt-1.5">
                <dt className="text-sm text-slate-600">Status</dt>
                <dd>
                  <Badge
                    tone={
                      settlement.status === "paid"
                        ? "green"
                        : settlement.status === "partial"
                          ? "amber"
                          : "rose"
                    }
                  >
                    {PAYMENT_STATUS_LABELS[settlement.status]}
                  </Badge>
                </dd>
              </div>
            </dl>
          </Section>

          {settlement.remaining > 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This bill leaves the counter {money(settlement.remaining)} short.
              {customerName.trim()
                ? ` It will be recorded as a due against ${customerName.trim()}, and can be settled from the bill later.`
                : " No customer is attached, so there will be nobody to chase it from."}
            </p>
          ) : null}

        </div>

        <div className="shrink-0 space-y-2 border-t border-slate-100 px-5 py-4">
          <p className="text-center text-[11px] text-slate-500">
            Stock is checked again as this is posted, so nothing sold elsewhere
            in the meantime can be billed here.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="btn-secondary flex-1 py-3"
            >
              Back
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              disabled={submitting}
              className="btn-primary flex-[2] py-3 text-base"
            >
              {submitting ? "Completing…" : `Complete Sale · ${money(plan.totalAmount)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

function Line({
  term,
  value,
  strong,
  tone,
}: {
  term: string;
  value: string;
  strong?: boolean;
  tone?: string;
}) {
  return (
    <div className={cx("flex items-center justify-between text-sm", tone)}>
      <dt className={cx(strong ? "font-semibold text-slate-900" : "text-slate-600")}>
        {term}
      </dt>
      <dd className={cx("tnum", strong ? "font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}
