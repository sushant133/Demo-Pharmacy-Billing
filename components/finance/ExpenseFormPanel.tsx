"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { toDateInputValue } from "@/lib/dates";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_METHODS,
  EXPENSE_METHOD_LABELS,
  type ExpenseCategory,
  type ExpenseMethod,
} from "@/lib/expense-categories";
import { money } from "@/lib/format";
import { DualDateField } from "@/components/DualDateField";
import { Field, SlideOver } from "@/components/SlideOver";

/**
 * Record or correct a running cost.
 *
 * `paidOn` defaults to today but is always editable, because expenses are
 * routinely entered a week later off a pile of receipts - and stamping them
 * all with the day they were typed would put January's rent in February's
 * books, which is exactly the error this screen exists to stop.
 */

export interface ExpenseFormValues {
  id: string;
  category: ExpenseCategory;
  description: string;
  payee: string;
  amount: number;
  method: ExpenseMethod;
  paidOn: string;
  reference: string;
  note: string;
}

export function ExpenseFormPanel({
  expense,
  returnHref = "/expenses",
}: {
  /** Null to record a new one. */
  expense: ExpenseFormValues | null;
  returnHref?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(expense);

  const [category, setCategory] = useState<ExpenseCategory>(
    expense?.category ?? "rent",
  );
  const [description, setDescription] = useState(expense?.description ?? "");
  const [payee, setPayee] = useState(expense?.payee ?? "");
  const [amount, setAmount] = useState(
    expense ? String(expense.amount) : "",
  );
  const [method, setMethod] = useState<ExpenseMethod>(expense?.method ?? "cash");
  const [paidOn, setPaidOn] = useState(expense?.paidOn ?? toDateInputValue());
  const [reference, setReference] = useState(expense?.reference ?? "");
  const [note, setNote] = useState(expense?.note ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  const typed = Number(amount);
  const ready =
    description.trim().length >= 2 &&
    Number.isFinite(typed) &&
    typed > 0 &&
    Boolean(paidOn);

  async function save() {
    if (inflight.current || !ready) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const body = {
      category,
      description: description.trim(),
      payee: payee.trim(),
      amount: typed,
      method,
      paidOn,
      reference: reference.trim(),
      note: note.trim(),
    };

    const result = await apiFetch(
      isEdit ? `/api/expenses/${expense!.id}` : "/api/expenses",
      { method: isEdit ? "PATCH" : "POST", json: body },
    );

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    close();
  }

  async function remove() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch(`/api/expenses/${expense!.id}`, {
      method: "DELETE",
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
      title={isEdit ? "Edit expense" : "Record an expense"}
      description={
        isEdit
          ? "Correcting what was entered."
          : "A running cost that is not stock - rent, wages, a utility bill."
      }
      onClose={close}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !ready}
            className="btn-primary flex-1"
          >
            {busy
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : ready
                  ? `Record ${money(typed)}`
                  : "Record expense"}
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
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        <Field
          label="Category"
          htmlFor="category"
          required
          hint="Fixed list, so the totals below the table actually add up."
        >
          <select
            id="category"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as ExpenseCategory)
            }
            className="input"
          >
            {EXPENSE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {EXPENSE_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="What it was for" htmlFor="description" required>
          <input
            id="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Shop rent for Ashadh"
            maxLength={200}
            className="input"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" htmlFor="amount" required>
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

          <Field label="Paid by" htmlFor="method">
            <select
              id="method"
              value={method}
              onChange={(event) => setMethod(event.target.value as ExpenseMethod)}
              className="input"
            >
              {EXPENSE_METHODS.map((value) => (
                <option key={value} value={value}>
                  {EXPENSE_METHOD_LABELS[value]}
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
          label="Paid to"
          htmlFor="payee"
          hint="The landlord, the employee, the utility board. Optional."
        >
          <input
            id="payee"
            value={payee}
            onChange={(event) => setPayee(event.target.value)}
            maxLength={160}
            className="input"
          />
        </Field>

        <Field
          label="Reference"
          htmlFor="reference"
          hint="Cheque number, bill number, transaction id. Optional."
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

        {isEdit ? (
          <div className="border-t border-slate-100 pt-4">
            {removing ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                <p className="text-xs text-rose-800">
                  Delete this expense? It comes straight out of the category
                  totals and the net profit figure.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={remove}
                    disabled={busy}
                    className="btn-danger flex-1 py-1.5 text-xs"
                  >
                    {busy ? "Deleting…" : "Delete expense"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoving(false)}
                    className="btn-secondary py-1.5 text-xs"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setRemoving(true)}
                className="text-xs font-medium text-rose-600 hover:underline"
              >
                Delete this expense
              </button>
            )}
          </div>
        ) : null}

        <button type="submit" className="sr-only">
          Save
        </button>
      </form>
    </SlideOver>
  );
}
