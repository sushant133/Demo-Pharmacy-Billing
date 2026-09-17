"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiFetch } from "@/lib/client";

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

  if (error) {
    return (
      <span className="text-xs text-rose-600" role="alert">
        {error}
      </span>
    );
  }

  if (!isActive) {
    return (
      <button
        type="button"
        onClick={() => apply(true)}
        disabled={busy}
        className="ml-3 text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50"
      >
        {busy ? "Working…" : "Activate"}
      </button>
    );
  }

  if (asking) {
    return (
      <span className="ml-3 inline-flex items-center gap-2 whitespace-normal">
        <span className="text-[11px] text-slate-600">
          Hide {name} from billing?
          {stockQuantity > 0
            ? ` Its ${stockQuantity} unit(s) stay in stock.`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => apply(false)}
          disabled={busy}
          className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
        >
          {busy ? "Working…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="text-xs font-medium text-slate-500 hover:underline"
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAsking(true)}
      className="ml-3 text-xs font-medium text-slate-500 hover:text-rose-600"
    >
      Deactivate
    </button>
  );
}
