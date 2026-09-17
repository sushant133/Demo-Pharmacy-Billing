"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  type SupplierPaymentMethod,
} from "@/lib/constants";
import { toDateInputValue } from "@/lib/dates";
import { money } from "@/lib/format";
import { DualDateField } from "@/components/DualDateField";
import { Field, SlideOver } from "@/components/SlideOver";

/**
 * Pay a supplier, from the payments ledger rather than from their page.
 *
 * The write path has existed since supplier balances landed; the only way in
 * was to open a supplier first, which is the wrong way round for somebody
 * sitting down to settle three invoices from a pile of cheques.
 *
 * Unpaid invoices are loaded once a supplier is chosen, so a payment can be
 * attached to the bill it settles - which is what keeps the payables ledger
 * meaningful - or left on account when the cheque covers several.
 */

interface SupplierHit {
  id: string;
  name: string;
  outstanding?: number;
}

interface OpenInvoice {
  id: string;
  grnNo: string;
  outstanding: number;
}

export function SupplierPaymentPanel({
  returnHref = "/payments",
}: {
  returnHref?: string;
}) {
  const router = useRouter();

  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SupplierHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);

  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [purchaseId, setPurchaseId] = useState("");

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<SupplierPaymentMethod>("cash");
  const [paidOn, setPaidOn] = useState(toDateInputValue());
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  useEffect(() => {
    const value = term.trim();
    if (value.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await apiFetch<SupplierHit[]>(
        `/api/suppliers?q=${encodeURIComponent(value)}`,
      );
      setSearching(false);
      if (result.ok) setHits(result.data);
    }, 250);

    return () => clearTimeout(timer);
  }, [term]);

  async function pick(next: SupplierHit) {
    setSupplier(next);
    setHits([]);
    setTerm("");
    setError(null);

    // Their unpaid invoices, so the payment can name the bill it settles.
    const result = await apiFetch<{ openInvoices?: OpenInvoice[] }>(
      `/api/suppliers/${next.id}`,
    );
    if (result.ok && Array.isArray(result.data.openInvoices)) {
      setInvoices(result.data.openInvoices);
    } else {
      setInvoices([]);
    }
  }

  const chosen = invoices.find((invoice) => invoice.id === purchaseId);
  const typed = Number(amount);
  const ready =
    Boolean(supplier) &&
    Number.isFinite(typed) &&
    typed > 0 &&
    Boolean(paidOn) &&
    // An invoice-attached payment cannot exceed what that invoice still owes;
    // the server refuses it too, and says to record the excess on account.
    (!chosen || typed <= chosen.outstanding + 0.005);

  async function submit() {
    if (!supplier || inflight.current || !ready) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch(`/api/suppliers/${supplier.id}/payments`, {
      method: "POST",
      json: {
        purchaseId: purchaseId || null,
        amount: typed,
        method,
        paidOn,
        reference: reference.trim(),
        note: note.trim(),
      },
    });

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    close();
  }

  return (
    <SlideOver
      title="Record a payment"
      description="Money paid out to a supplier."
      onClose={close}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy || !ready}
            className="btn-primary flex-1"
          >
            {busy ? "Recording…" : ready ? `Pay ${money(typed)}` : "Record payment"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Cancel
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        {!supplier ? (
          <div>
            <label htmlFor="supplier-search" className="label">
              Supplier
            </label>
            <input
              id="supplier-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search by name"
              autoComplete="off"
              className="input"
            />
            {searching ? (
              <p className="mt-1 text-xs text-slate-500">Searching…</p>
            ) : null}
            {hits.length > 0 ? (
              <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      onClick={() => pick(hit)}
                      className="flex w-full items-baseline justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="truncate text-sm font-medium text-slate-900">
                        {hit.name}
                      </span>
                      {hit.outstanding ? (
                        <span className="tnum shrink-0 text-xs font-medium text-amber-700">
                          {money(hit.outstanding)} owed
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">
                  {supplier.name}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">
                  {invoices.length > 0
                    ? `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"}`
                    : "Nothing outstanding on a specific invoice"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSupplier(null);
                  setInvoices([]);
                  setPurchaseId("");
                }}
                className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
              >
                Change
              </button>
            </div>

            {invoices.length > 0 ? (
              <Field
                label="Against"
                htmlFor="purchaseId"
                hint="Attach it to the invoice it settles, or leave on account when one cheque covers several."
              >
                <select
                  id="purchaseId"
                  value={purchaseId}
                  onChange={(event) => {
                    setPurchaseId(event.target.value);
                    const next = invoices.find(
                      (invoice) => invoice.id === event.target.value,
                    );
                    // Settling in full is what happens most of the time, so the
                    // outstanding figure is offered rather than read off and retyped.
                    if (next) setAmount(next.outstanding.toFixed(2));
                  }}
                  className="input"
                >
                  <option value="">On account</option>
                  {invoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.grnNo} · {money(invoice.outstanding)} outstanding
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Amount"
                htmlFor="amount"
                required
                error={
                  chosen && typed > chosen.outstanding + 0.005
                    ? `${chosen.grnNo} only has ${money(chosen.outstanding)} outstanding.`
                    : undefined
                }
              >
                <input
                  id="amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="input tnum"
                  required
                />
              </Field>

              <Field label="Method" htmlFor="method">
                <select
                  id="method"
                  value={method}
                  onChange={(event) =>
                    setMethod(event.target.value as SupplierPaymentMethod)
                  }
                  className="input"
                >
                  {SUPPLIER_PAYMENT_METHODS.map((value) => (
                    <option key={value} value={value}>
                      {SUPPLIER_PAYMENT_METHOD_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div>
              <p className="label">Paid on</p>
              <DualDateField
                id="paidOn"
                value={paidOn}
                onChange={setPaidOn}
                compact
                aria-label="Paid on"
              />
            </div>

            <Field
              label="Reference"
              htmlFor="reference"
              hint="Cheque number, transaction id. Optional."
            >
              <input
                id="reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                maxLength={120}
                className="input"
              />
            </Field>

            <Field label="Note" htmlFor="note">
              <textarea
                id="note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={300}
                className="input"
              />
            </Field>
          </>
        )}
      </div>
    </SlideOver>
  );
}
