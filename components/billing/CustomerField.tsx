"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, qs } from "@/lib/client";
import { money } from "@/lib/format";
import { cx } from "@/components/ui";

/**
 * Customer field for the POS.
 *
 * Most sales are walk-ins, so typing a name and moving on must stay the fast
 * path. Searching only starts once two characters are typed, and a match can
 * be attached with Enter to link the bill to a saved customer record.
 *
 * Two outputs, deliberately:
 *   - `customerId` set  -> the bill links to a saved customer
 *   - name only         -> a walk-in name printed on the bill, nothing stored
 */

interface CustomerHit {
  id: string;
  name: string;
  phone: string;
  address: string;
  panNo: string;
  /** What this customer already owes across their unsettled bills. */
  outstanding: number;
}

export function CustomerField({
  name,
  customerId,
  phone,
  address,
  panNo,
  canAdd = false,
  onChange,
}: {
  name: string;
  customerId: string | null;
  /** Current buyer fields, so saving a walk-in does not ask for them twice. */
  phone?: string;
  address?: string;
  panNo?: string;
  /** Whether this user may write to the customer register. */
  canAdd?: boolean;
  onChange: (next: {
    name: string;
    customerId: string | null;
    phone?: string;
    address?: string;
    panNo?: string;
  }) => void;
}) {
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // A linked customer is a settled choice; stop searching until it is cleared.
  useEffect(() => {
    const term = name.trim();
    if (customerId || term.length < 2) {
      setHits([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await apiFetch<CustomerHit[]>("/api/customers" + qs({ q: term }), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setHits(result.ok ? result.data : []);
      setHighlight(0);
      setOpen(result.ok && result.data.length > 0);
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [name, customerId]);

  // Clicking anywhere else dismisses the suggestions.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function select(hit: CustomerHit) {
    onChange({
      name: hit.name,
      customerId: hit.id,
      phone: hit.phone,
      address: hit.address,
      panNo: hit.panNo,
    });
    setOpen(false);
    setHits([]);
    setSaveError(null);
  }

  /**
   * File the name already typed as a returning customer, and link the bill to
   * it in the same step.
   *
   * There is no separate form: the till already holds the name, and the phone,
   * address and PAN it asks for on larger bills. Making the counter retype
   * those into a dialog is how a queue forms, so "+ Add" saves what is there
   * and the buyer fields above stay the place to correct it.
   */
  async function addCustomer() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;

    setSaving(true);
    setSaveError(null);

    const result = await apiFetch<{ id: string }>("/api/customers", {
      method: "POST",
      json: {
        name: trimmed,
        phone: phone?.trim() ?? "",
        address: address?.trim() ?? "",
        panNo: panNo?.trim() ?? "",
      },
    });

    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }

    onChange({
      name: trimmed,
      customerId: result.data.id,
      phone: phone ?? "",
      address: address ?? "",
      panNo: panNo ?? "",
    });
    setOpen(false);
    setHits([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      // Enter attaches the highlighted customer instead of submitting.
      event.preventDefault();
      const hit = hits[highlight];
      if (hit) select(hit);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="customer" className="label">
          Customer <span className="font-normal text-slate-400">optional</span>
        </label>

        {/*
          Only offered once there is a name to save and nothing linked yet -
          a button that cannot do anything is worse than no button on a screen
          this busy.
        */}
        {canAdd && !customerId && name.trim().length >= 2 ? (
          <button
            type="button"
            onClick={addCustomer}
            disabled={saving}
            className="mb-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
          >
            {saving ? "Saving…" : "+ Add customer"}
          </button>
        ) : null}
      </div>

      <div className="relative">
        <input
          id="customer"
          value={name}
          autoComplete="off"
          onChange={(event) =>
            onChange({ name: event.target.value, customerId: null, panNo: "", address: "", phone: "" })
          }
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(hits.length > 0)}
          placeholder="Walk-in"
          role="combobox"
          aria-expanded={open}
          aria-controls="customer-results"
          className={cx("input", customerId && "pr-20")}
        />

        {customerId ? (
          <button
            type="button"
            onClick={() =>
              onChange({ name: "", customerId: null, panNo: "", address: "", phone: "" })
            }
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-200"
            title="Unlink this customer"
          >
            Linked ✕
          </button>
        ) : null}
      </div>

      {saveError ? (
        <p role="alert" className="mt-1 text-[11px] text-rose-700">
          {saveError}
        </p>
      ) : null}

      {open && hits.length > 0 ? (
        <ul
          id="customer-results"
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg"
        >
          {hits.map((hit, index) => (
            <li key={hit.id} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(index)}
                onClick={() => select(hit)}
                className={cx(
                  "w-full px-3 py-2 text-left transition-colors",
                  index === highlight ? "bg-brand-50" : "hover:bg-slate-50",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {hit.name}
                  </p>
                  {/*
                    What they already owe, before the counter decides whether
                    to let them have another bill on credit.
                  */}
                  {hit.outstanding > 0 ? (
                    <span className="tnum shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      {money(hit.outstanding)} due
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-slate-500">
                  {[hit.phone, hit.address].filter(Boolean).join(" · ") || "—"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
