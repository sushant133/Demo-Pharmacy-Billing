"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/client";
import { ActionIcon } from "@/components/action-icons";
import { cx } from "@/components/ui";

/**
 * Take a medicine off the till, or put it back, from its row in the list.
 *
 * Deactivating was already possible - buried in the edit panel behind an
 * "Active" checkbox - which meant retiring a discontinued line cost opening a
 * form, finding a tickbox and saving. This is the same write, at the place the
 * decision is actually made.
 *
 * Deactivating asks first; reactivating does not. Turning a line back on is
 * harmless and instantly visible, while turning it off removes it from the
 * counter's search and is the sort of thing somebody does by accident at speed
 * on a crowded row of links.
 *
 * It does not touch stock. An inactive medicine keeps every lot it had - the
 * shop has simply stopped selling it - which is why the confirmation says so
 * rather than leaving anybody to wonder whether units just vanished.
 *
 * The question and any error float above the row rather than sitting in it.
 * Now that the actions column is a fixed strip of icons, a sentence rendered
 * inline would stretch that column back out - and only for whichever single
 * row happened to be mid-confirmation.
 */
export function MedicineActiveToggle({
  id,
  name,
  isActive,
  stockQuantity,
}: {
  id: string;
  name: string;
  isActive: boolean;
  /** Sellable units still on the shelf, named in the confirmation. */
  stockQuantity: number;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  async function apply(next: boolean) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch(`/api/medicines/${id}`, {
      method: "PATCH",
      json: { isActive: next },
    });

    inflight.current = false;
    setBusy(false);
    setAsking(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  if (!isActive) {
    return (
      <Popped message={error} onDismiss={() => setError(null)}>
        <ActionIcon
          label="Activate"
          icon="activate"
          tone="success"
          disabled={busy}
          onClick={() => apply(true)}
        />
      </Popped>
    );
  }

  return (
    <Popped
      message={error}
      onDismiss={() => setError(null)}
      confirm={
        asking ? (
          <>
            <p className="text-sm leading-snug text-slate-600">
              Hide <span className="font-medium text-slate-900">{name}</span>{" "}
              from billing?
              {stockQuantity > 0
                ? ` Its ${stockQuantity} unit(s) stay in stock.`
                : ""}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => apply(false)}
                disabled={busy}
                className="btn-danger flex-1 py-1.5 text-xs disabled:opacity-50"
              >
                {busy ? "Working…" : "Deactivate"}
              </button>
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="btn-secondary py-1.5 text-xs"
              >
                Cancel
              </button>
            </div>
          </>
        ) : null
      }
    >
      <ActionIcon
        label="Deactivate"
        icon="deactivate"
        tone="danger"
        onClick={() => setAsking(true)}
      />
    </Popped>
  );
}

/**
 * The icon, plus whatever has to be said about it.
 *
 * The question is asked in a small centred dialog rather than a panel floated
 * off the row. A floated panel cannot survive here: the table now owns its own
 * horizontal scrolling, and the moment one axis of an element is not
 * `visible` the other becomes a scroll container too - so anything taller
 * than the header row above it is clipped on the first row of every table.
 * A fixed dialog has no such ancestor, and on a phone it is the better answer
 * anyway: a 224px panel hanging off a 32px icon was never comfortable to read.
 */
function Popped({
  children,
  confirm,
  message,
  onDismiss,
}: {
  children: ReactNode;
  confirm?: ReactNode;
  /** A failed write, shown in place of the question. */
  message?: string | null;
  onDismiss: () => void;
}) {
  const open = Boolean(message) || Boolean(confirm);

  return (
    <>
      {children}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 pb-[calc(1rem+var(--safe-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="Cancel"
            onClick={onDismiss}
            className="absolute inset-0 bg-slate-900/40"
          />

          <div
            className={cx(
              "relative w-full max-w-sm rounded-xl border p-4 text-left shadow-xl",
              message
                ? "border-rose-200 bg-rose-50"
                : "border-slate-200 bg-white",
            )}
          >
            {message ? (
              <div role="alert">
                <p className="text-sm leading-snug text-rose-700">{message}</p>
                <button
                  type="button"
                  onClick={onDismiss}
                  className="btn-secondary mt-3 w-full py-1.5 text-xs"
                >
                  Dismiss
                </button>
              </div>
            ) : (
              confirm
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
