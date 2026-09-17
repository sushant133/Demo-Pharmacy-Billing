"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/sale-payment";
import { Badge, cx } from "@/components/ui";

/**
 * Steps 11 and 12: the bill exists, and the counter decides what to do with it.
 *
 * The till used to jump straight to the printable receipt. That is the right
 * default exactly once - when the printer is the next step - and wrong every
 * other time: it strands the cashier on another screen when the customer wants
 * a copy emailed, or when the next person in the queue is already waiting.
 *
 * So nothing navigates on its own. The bill number is shown, the four things
 * anyone actually does with it are offered, and "New sale" is the loudest.
 */

export interface CompletedSale {
  id: string;
  billNo: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  itemCount: number;
  paymentMode: PaymentMode;
  totalDue: number;
  paid: number;
  remaining: number;
  changeDue: number;
  status: PaymentStatus;
}

export function SaleComplete({
  sale,
  canReceivePayment = false,
  onNewSale,
}: {
  sale: CompletedSale;
  /** Whether this user may take money against the bill they just raised. */
  canReceivePayment?: boolean;
  onNewSale: () => void;
}) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  // Settling a due does not create a new bill, so the panel updates in place
  // rather than sending the cashier somewhere else and back.
  const [settled, setSettled] = useState({
    paid: sale.paid,
    remaining: sale.remaining,
    status: sale.status,
  });
  const [receiving, setReceiving] = useState(false);
  const newSaleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    newSaleRef.current?.focus();
  }, []);

  // F2 already means "new sale" everywhere in the app; here it is also the
  // way out of this panel, so the queue never waits on a mouse.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, a, button")) return;
      event.preventDefault();
      onNewSale();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNewSale]);

  const billUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/bills/${sale.id}`
      : `/bills/${sale.id}`;
  const phone = sale.customerPhone.replace(/[^\d+]/g, "");
  // A shared invoice says what is still owed, if anything - that is usually
  // the reason it is being sent.
  const message =
    `Invoice ${sale.billNo} for ${money(sale.totalDue)}.` +
    (settled.remaining > 0.004 ? ` ${money(settled.remaining)} outstanding.` : "") +
    ` View it here: ${billUrl}`;

  async function share() {
    setShareNote(null);
    if (canShare) {
      try {
        await navigator.share({
          title: `Invoice ${sale.billNo}`,
          text: message,
          url: billUrl,
        });
        return;
      } catch {
        // Cancelled, or the sheet refused; fall through to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(message);
      setShareNote("Invoice link copied. Paste it into any message.");
    } catch {
      setShareNote(billUrl);
    }
  }

  return (
    <div className="mx-auto max-w-xl py-4 sm:py-8">
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 bg-emerald-50/60 px-5 py-5 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>

          <h1 className="mt-3 text-lg font-semibold text-slate-900">Sale completed</h1>
          <p className="mt-1 text-sm text-slate-600">
            Invoice{" "}
            <span className="tnum font-semibold text-slate-900">{sale.billNo}</span>
            {" · "}
            {sale.itemCount} item{sale.itemCount === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {sale.customerName.trim() || "Walk-in customer"} · stock updated
          </p>
        </div>

        {/* The payment summary, in the shape the counter reads it out. */}
        <div className="border-b border-slate-100 px-5 py-4">
          <dl className="mx-auto max-w-xs space-y-1">
            <Figure label="Total" value={money(sale.totalDue)} />
            <Figure label="Paid" value={money(settled.paid)} />
            {settled.remaining > 0.004 ? (
              <Figure
                label="Remaining"
                value={money(settled.remaining)}
                tone="text-amber-700"
                strong
              />
            ) : null}
            {sale.changeDue > 0.004 ? (
              <Figure
                label="Change"
                value={money(sale.changeDue)}
                tone="text-emerald-700"
                strong
              />
            ) : null}
            <div className="flex items-center justify-between pt-1.5">
              <dt className="text-sm text-slate-600">Status</dt>
              <dd>
                <Badge
                  tone={
                    settled.status === "paid"
                      ? "green"
                      : settled.status === "partial"
                        ? "amber"
                        : "rose"
                  }
                >
                  {PAYMENT_STATUS_LABELS[settled.status]}
                </Badge>
              </dd>
            </div>
          </dl>

          {settled.remaining > 0.004 ? (
            <p className="mt-3 text-center text-[11px] text-slate-500">
              {sale.customerId
                ? `Recorded as a due against ${sale.customerName.trim()}.`
                : "Recorded against this invoice. No customer is attached, so it cannot be chased."}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-3">
          <Action
            as="link"
            href={`/bills/${sale.id}?print=1`}
            icon="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-5a2 2 0 012-2h14a2 2 0 012 2v5a1 1 0 01-1 1h-2M6 14h12v7H6z"
          >
            Print invoice
          </Action>

          {/*
            A plain link, not fetch-then-blob: the response already carries
            Content-Disposition, so the browser saves it with the right name
            and an Android WebView handles it the same way it handles any other
            download.
          */}
          <Action
            as="link"
            href={`/api/sales/${sale.id}/invoice`}
            download
            icon="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
          >
            Download PDF
          </Action>

          <Action
            as="button"
            onClick={share}
            icon="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4M18 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM6 15a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm12 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
          >
            Send invoice
          </Action>
        </div>

        {shareNote ? (
          <p
            role="status"
            className="mx-4 -mt-1 mb-3 rounded-lg bg-slate-50 px-3 py-2 text-center text-xs break-all text-slate-600"
          >
            {shareNote}
          </p>
        ) : null}

        {phone.length >= 7 ? (
          <div className="flex flex-wrap justify-center gap-2 px-4 pb-3">
            <a
              href={`https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50"
            >
              WhatsApp to {sale.customerPhone}
            </a>
            <a
              href={`sms:${phone}?&body=${encodeURIComponent(message)}`}
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50"
            >
              SMS
            </a>
          </div>
        ) : null}

        {/*
          Receive payment.
          Offered only while something is actually owed, because a button that
          can only be refused is worse than no button. Settling here updates
          this panel in place - the cashier is mid-queue, and sending them to
          another screen to take Rs 500 is how the next customer waits.
        */}
        {settled.remaining > 0.004 && canReceivePayment ? (
          <div className="border-t border-slate-100 px-4 py-4">
            {receiving ? (
              <ReceivePaymentForm
                saleId={sale.id}
                billNo={sale.billNo}
                remaining={settled.remaining}
                onCancel={() => setReceiving(false)}
                onReceived={(next) => {
                  setSettled(next);
                  setReceiving(false);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setReceiving(true)}
                className="btn-secondary w-full py-2.5"
              >
                Receive payment · {money(settled.remaining)} due
              </button>
            )}
          </div>
        ) : null}

        <div className="border-t border-slate-100 px-4 py-4">
          <button
            ref={newSaleRef}
            type="button"
            onClick={onNewSale}
            className="btn-primary w-full py-3.5 text-base"
          >
            New sale
            <kbd className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">
              Enter
            </kbd>
          </button>

          <div className="mt-2 flex justify-center gap-4 text-xs">
            <Link href={`/sales/${sale.id}`} className="text-slate-500 hover:text-slate-900">
              Open this bill
            </Link>
            <Link href="/sales" className="text-slate-500 hover:text-slate-900">
              All sales
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line of the payment summary. */
function Figure({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div className={cx("flex items-center justify-between text-sm", tone)}>
      <dt className={cx(strong ? "font-medium" : "text-slate-600")}>{label}</dt>
      <dd className={cx("tnum", strong ? "font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}

/**
 * Take money against the bill that was just raised.
 *
 * The server refuses more than is outstanding, so this caps the input at the
 * same figure rather than letting the cashier type 2000 against a 500 due and
 * find out after pressing the button.
 */
function ReceivePaymentForm({
  saleId,
  billNo,
  remaining,
  onCancel,
  onReceived,
}: {
  saleId: string;
  billNo: string;
  remaining: number;
  onCancel: () => void;
  onReceived: (next: {
    paid: number;
    remaining: number;
    status: PaymentStatus;
  }) => void;
}) {
  const [amount, setAmount] = useState(remaining.toFixed(2));
  const [method, setMethod] = useState<PaymentMode>("cash");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    amountRef.current?.select();
  }, []);

  const value = Number(amount) || 0;
  const valid = value > 0 && value <= remaining + 0.005;

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);

    const result = await apiFetch<{
      paid: number;
      remaining: number;
      status: PaymentStatus;
    }>(`/api/sales/${saleId}/payments`, {
      method: "POST",
      json: { amount: value, method },
    });

    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onReceived({
      paid: result.data.paid,
      remaining: result.data.remaining,
      status: result.data.status,
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
      <p className="text-xs font-semibold text-slate-900">
        Receive payment on {billNo}
      </p>
      <p className="tnum mt-0.5 text-[11px] text-slate-500">
        {money(remaining)} outstanding
      </p>

      <div className="mt-2.5 flex flex-wrap items-end gap-2">
        <div>
          <label
            htmlFor="receive-amount"
            className="mb-1 block text-[11px] font-medium text-slate-500"
          >
            Amount
          </label>
          <input
            id="receive-amount"
            ref={amountRef}
            type="number"
            min={0}
            max={remaining}
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            className="input tnum w-32"
          />
        </div>

        <div className="min-w-0 flex-1">
          <label
            htmlFor="receive-method"
            className="mb-1 block text-[11px] font-medium text-slate-500"
          >
            Method
          </label>
          <select
            id="receive-method"
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMode)}
            className="input"
          >
            {PAYMENT_MODES.filter((mode) => mode !== "credit").map((mode) => (
              <option key={mode} value={mode}>
                {PAYMENT_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost flex-1 text-sm">
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!valid || saving}
          className="btn-primary flex-[2] text-sm"
        >
          {saving ? "Recording…" : `Record ${money(value)}`}
        </button>
      </div>
    </div>
  );
}

/** One of the three post-sale choices. Same box whether it links or acts. */
function Action(
  props: {
    icon: string;
    children: ReactNode;
  } & (
    | { as: "link"; href: string; download?: boolean }
    | { as: "button"; onClick: () => void }
  ),
) {
  const className = cx(
    "flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-3",
    "text-sm font-medium text-slate-700 transition-colors hover:border-brand-200 hover:bg-brand-50",
  );

  const body = (
    <>
      <svg
        className="h-4.5 w-4.5 shrink-0 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.7}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={props.icon} />
      </svg>
      {props.children}
    </>
  );

  if (props.as === "link") {
    return (
      <a
        href={props.href}
        download={props.download}
        target={props.download ? undefined : "_blank"}
        rel={props.download ? undefined : "noopener noreferrer"}
        className={className}
      >
        {body}
      </a>
    );
  }

  return (
    <button type="button" onClick={props.onClick} className={className}>
      {body}
    </button>
  );
}
