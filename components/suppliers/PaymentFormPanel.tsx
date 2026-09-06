"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { DualDateField } from "@/components/DualDateField";
import { Field, SlideOver } from "@/components/SlideOver";
import { SUPPLIER_PAYMENT_METHODS, SUPPLIER_PAYMENT_METHOD_LABELS } from "@/lib/constants";

/**
 * Record a payment to a supplier.
 *
 * A payment either settles one invoice or goes on account against the overall
 * balance. Picking an invoice pre-fills its outstanding amount, since paying
 * a bill in full is by far the common case.
 */

export interface OpenInvoice {
  id: string;
  grnNo: string;
  outstanding: number;
}

export function PaymentFormPanel({
  supplierId,
  supplierName,
  outstanding,
  openInvoices,
  today,
  presetInvoiceId,
}: {
  supplierId: string;
  supplierName: string;
  outstanding: number;
  openInvoices: OpenInvoice[];
  today: string;
  presetInvoiceId?: string;
}) {
  const router = useRouter();

  const [purchaseId, setPurchaseId] = useState(presetInvoiceId ?? "");
  const [amount, setAmount] = useState(() => {
    const preset = openInvoices.find((invoice) => invoice.id === presetInvoiceId);
    return preset ? String(preset.outstanding) : "";
  });
  const [method, setMethod] = useState("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = useCallback(() => {
    router.push(`/suppliers/${supplierId}`);
    router.refresh();
  }, [router, supplierId]);

  const selectedInvoice = useMemo(
    () => openInvoices.find((invoice) => invoice.id === purchaseId) ?? null,
    [openInvoices, purchaseId],
  );

  function onInvoiceChange(nextId: string) {
    setPurchaseId(nextId);
    const invoice = openInvoices.find((entry) => entry.id === nextId);
    // Paying a bill in full is the norm, so pre-fill it and let them edit down.
    if (invoice) setAmount(String(invoice.outstanding));
  }

  async function save() {
    setFormError(null);

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFormError("Enter an amount greater than zero.");
      return;
    }
    if (selectedInvoice && value > selectedInvoice.outstanding + 0.005) {
      setFormError(
        `${selectedInvoice.grnNo} only has ${money(selectedInvoice.outstanding)} outstanding. Record the excess as an on-account payment instead.`,
      );
      return;
    }

    setSaving(true);

    const result = await apiFetch(`/api/suppliers/${supplierId}/payments`, {
      method: "POST",
      json: {
        purchaseId: purchaseId || null,
        amount: value,
        method,
        paidOn,
        reference: reference.trim(),
        note: note.trim(),
      },
    });

    if (!result.ok) {
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  return (
    <SlideOver
      title="Record payment"
      description={`Money paid to ${supplierName}. Outstanding right now: ${money(outstanding)}.`}
      onClose={close}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? "Saving…" : "Record payment"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Cancel
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {formError}
          </div>
        ) : null}

        <Field
          label="Against invoice"
          htmlFor="purchaseId"
          hint="Leave as on-account to pay down the overall balance."
        >
          <select
            id="purchaseId"
            value={purchaseId}
            onChange={(event) => onInvoiceChange(event.target.value)}
            className="input"
          >
            <option value="">On account (no specific invoice)</option>
            {openInvoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.grnNo} — {money(invoice.outstanding)} due
              </option>
            ))}
          </select>
        </Field>

        <Field label="Amount (Rs)" htmlFor="amount">
          <input
            id="amount"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input tnum text-lg"
            required
            autoFocus
          />
        </Field>

        <Field label="Method" htmlFor="method">
          <select
            id="method"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className="input"
          >
            {SUPPLIER_PAYMENT_METHODS.map((option) => (
              <option key={option} value={option}>
                {SUPPLIER_PAYMENT_METHOD_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Paid on" htmlFor="paidOn">
          <DualDateField
            id="paidOn"
            value={paidOn}
            onChange={setPaidOn}
            required
            aria-label="Paid on"
          />
        </Field>

        <Field
          label="Reference"
          htmlFor="reference"
          hint="Cheque number, transaction id, or similar."
        >
          <input
            id="reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            className="input"
          />
        </Field>

        <Field label="Note" htmlFor="note">
          <textarea
            id="note"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="input resize-none"
          />
        </Field>

        <button type="submit" className="sr-only">
          Save
        </button>
      </form>
    </SlideOver>
  );
}
