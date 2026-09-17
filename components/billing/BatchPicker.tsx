"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, qs } from "@/lib/client";
import { describeExpiry, formatExpiry, money } from "@/lib/format";
import { describeStock, unitWord } from "@/lib/pack";
import { cx } from "@/components/ui";

/**
 * Steps 3 and 4 of the counter flow: choose the lot, then the quantity.
 *
 * FEFO is still the system's answer - the earliest valid expiry is selected
 * the moment the panel opens, and the badge says so - but a counter has
 * reasons the allocator cannot know: a crushed strip, a lot the customer is
 * already part-way through, a shelf being cleared. So the other valid lots are
 * offered, and expired ones are listed and disabled rather than hidden, which
 * is what tells staff *why* stock they can see cannot be sold.
 *
 * The quantity ceiling follows the choice: pinned to one lot it is that lot's
 * own count, on Auto it is everything sellable across lots. Either way the
 * server re-checks it, so this is a guard rail, not the lock.
 */

/**
 * The lot table's one column definition, shared by the heading, the rows and
 * the disabled expired rows so the four tracks cannot drift apart. Proportional
 * rather than `auto`, so a long batch number widens nothing but its own column.
 */
const COLUMNS =
  "grid items-center gap-2 grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)_minmax(0,0.9fr)_minmax(0,1fr)]";

/**
 * `expiryTone` dresses a date as a badge. In a column of dates that is a
 * stack of badges, so the same four thresholds are spelled here as text
 * colour alone - and a lot with months left gets no colour at all, because
 * "fine" is the thing a cashier never needs pointed out.
 */
function expiryTextTone(days: number): string {
  if (days < 0) return "text-rose-700";
  if (days <= 30) return "text-orange-700";
  if (days <= 90) return "text-amber-700";
  return "text-slate-600";
}

export interface TillBatch {
  id: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string;
  salePrice: number;
  expired: boolean;
  daysRemaining: number;
}

export interface PickedItem {
  batchId: string | null;
  quantity: number;
  /**
   * Units the choice can actually supply: one lot's own count when pinned,
   * every sellable unit when on Auto. The cart caps its stepper with this, so
   * a line pinned to a lot of 6 cannot be nudged to 40 because the medicine
   * has 40 across the shelf.
   */
  available: number;
}

export function BatchPicker({
  medicineId,
  medicineName,
  unit,
  unitsPerStrip,
  totalStock,
  onAdd,
  onCancel,
}: {
  medicineId: string;
  medicineName: string;
  unit: string;
  unitsPerStrip: number;
  /** Sellable units across every lot, as the search result reported them. */
  totalStock: number;
  onAdd: (item: PickedItem) => void;
  onCancel: () => void;
}) {
  const [batches, setBatches] = useState<TillBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void (async () => {
      const result = await apiFetch<TillBatch[]>(
        "/api/batches" + qs({ medicineId, till: "1", pageSize: 50 }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.ok) setBatches(result.data);
      else setError(result.message);
      setLoading(false);
    })();

    return () => controller.abort();
  }, [medicineId]);

  // Earliest valid expiry first - the same order the allocator works in, so
  // what the counter reads top-to-bottom is the order stock will leave.
  const sellable = useMemo(
    () =>
      batches
        .filter((batch) => !batch.expired && batch.quantity > 0)
        .sort(
          (a, b) =>
            new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime(),
        ),
    [batches],
  );
  const expired = useMemo(
    () => batches.filter((batch) => batch.expired),
    [batches],
  );

  const fefoId = sellable[0]?.id ?? null;
  const chosen = batchId ? (sellable.find((b) => b.id === batchId) ?? null) : null;

  // Auto draws on everything sellable; a pinned lot can only give what it has.
  const sellableTotal = sellable.reduce((sum, batch) => sum + batch.quantity, 0);
  const ceiling = chosen ? chosen.quantity : sellableTotal || totalStock;

  const parsed = Math.floor(Number(qty));
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= ceiling;
  const tooMany = Number.isFinite(parsed) && parsed > ceiling;

  // The panel exists to take a quantity; put the cursor where it is typed.
  useEffect(() => {
    if (!loading) qtyRef.current?.select();
  }, [loading]);

  function submit() {
    if (!valid) return;
    onAdd({ batchId, quantity: parsed, available: ceiling });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Enter") return;

    // Enter on a focused button already activates it, and the event then
    // bubbles up here. Without this guard, pressing Enter on Cancel would
    // close the panel *and* add the item on the way out.
    if ((event.target as HTMLElement | null)?.closest("button")) return;

    event.preventDefault();
    submit();
  }

  const perStrip = unitsPerStrip || 1;

  return (
    <div
      className="mt-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3 sm:p-4"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {medicineName}
          </p>
          <p className="text-xs text-slate-500">
            Choose a batch and quantity
            {sellableTotal > 0 ? (
              <>
                <span className="mx-1 text-slate-300">·</span>
                {describeStock(sellableTotal, perStrip, unit)} sellable
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="-mr-1 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
          aria-label="Cancel"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Loading batches…</p>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      ) : sellable.length === 0 ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {expired.length > 0
            ? "Every lot of this medicine on the shelf has expired. It cannot be sold."
            : "No sellable stock at this outlet."}
        </p>
      ) : (
        <>
          {/*
            Four columns on a fixed proportional grid, every one of them left
            aligned. The counts and prices used to be pushed to the right edge
            on `auto` tracks, which left each column a different width per
            medicine and put the headings nowhere near the figures they name.
          */}
          <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div
              className={cx(
                COLUMNS,
                "border-b border-slate-100 bg-slate-50/70 px-4 py-2 text-[10px] font-semibold tracking-wide text-slate-500 uppercase",
              )}
            >
              <span>Batch</span>
              <span>Available</span>
              <span>Expiry</span>
              <span>Price</span>
            </div>

            <ul className="max-h-52 divide-y divide-slate-100 overflow-y-auto">
              <li>
                <button
                  type="button"
                  onClick={() => setBatchId(null)}
                  aria-pressed={batchId === null}
                  className={cx(
                    COLUMNS,
                    "w-full px-4 py-2.5 text-left transition-colors",
                    batchId === null ? "bg-brand-50" : "hover:bg-slate-50",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Radio on={batchId === null} />
                    <span className="truncate text-xs font-medium text-slate-900">
                      Auto (FEFO)
                    </span>
                  </span>
                  <span className="tnum text-xs text-slate-600">{sellableTotal}</span>
                  <span className="text-xs text-slate-600">
                    {sellable[0] ? formatExpiry(sellable[0].expiryDate) : "—"}
                  </span>
                  <span className="tnum text-xs text-slate-600">
                    {sellable[0] ? money(sellable[0].salePrice) : "—"}
                  </span>
                </button>
              </li>

              {sellable.map((batch) => (
                <li key={batch.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchId(batch.id);
                      // Never leave a quantity behind that this lot cannot fill.
                      if (parsed > batch.quantity) setQty(String(batch.quantity));
                    }}
                    aria-pressed={batchId === batch.id}
                    className={cx(
                      COLUMNS,
                      "w-full px-4 py-2.5 text-left transition-colors",
                      batchId === batch.id ? "bg-brand-50" : "hover:bg-slate-50",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Radio on={batchId === batch.id} />
                      <span className="truncate font-mono text-xs font-medium text-slate-800">
                        {batch.batchNumber}
                      </span>
                      {batch.id === fefoId ? (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-700 uppercase">
                          FEFO
                        </span>
                      ) : null}
                    </span>
                    <span className="tnum text-xs text-slate-600">
                      {batch.quantity}
                    </span>
                    {/*
                      A date in a column of dates, coloured rather than
                      capsuled: a pill per row turned the expiry column into a
                      stack of badges competing with the FEFO mark beside it.
                    */}
                    <span
                      className={cx(
                        "text-xs font-medium",
                        expiryTextTone(batch.daysRemaining),
                      )}
                    >
                      {formatExpiry(batch.expiryDate)}
                    </span>
                    <span className="tnum text-xs font-medium text-slate-900">
                      {money(batch.salePrice)}
                    </span>
                  </button>
                </li>
              ))}

              {expired.map((batch) => (
                <li
                  key={batch.id}
                  className={cx(COLUMNS, "cursor-not-allowed px-4 py-2.5 opacity-60")}
                  title="Expired stock cannot be sold"
                >
                  <span className="flex min-w-0 items-center gap-2 pl-[1.375rem]">
                    <span className="truncate font-mono text-xs text-slate-500 line-through">
                      {batch.batchNumber}
                    </span>
                    <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-rose-700 uppercase">
                      Expired
                    </span>
                  </span>
                  <span className="tnum text-xs text-slate-500">
                    {batch.quantity}
                  </span>
                  <span className="text-xs font-medium text-rose-700">
                    {formatExpiry(batch.expiryDate)}
                  </span>
                  <span className="tnum text-xs text-slate-400">
                    {money(batch.salePrice)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label
                htmlFor="pick-qty"
                className="mb-1 block text-[11px] font-medium text-slate-500"
              >
                Quantity ({unitWord(unit, 2)})
              </label>
              <div className="flex items-center rounded-xl bg-white ring-1 ring-slate-200 ring-inset">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQty(String(Math.max(1, parsed - 1)))}
                  className="px-3 py-2 text-slate-500 hover:text-slate-900"
                >
                  −
                </button>
                <input
                  id="pick-qty"
                  ref={qtyRef}
                  type="number"
                  min={1}
                  max={ceiling}
                  value={qty}
                  onChange={(event) => setQty(event.target.value)}
                  className="tnum w-16 border-0 bg-transparent py-2 text-center text-sm font-semibold focus:ring-0 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQty(String(Math.min(ceiling, parsed + 1)))}
                  className="px-3 py-2 text-slate-500 hover:text-slate-900"
                >
                  +
                </button>
              </div>
            </div>

            {perStrip > 1 && ceiling >= perStrip ? (
              <button
                type="button"
                onClick={() => setQty(String(Math.min(ceiling, perStrip)))}
                className="rounded-lg bg-white px-2.5 py-2 text-xs font-medium text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-50"
              >
                1 strip ({perStrip})
              </button>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={onCancel} className="btn-ghost text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!valid}
                className="btn-primary text-sm"
              >
                Add to cart
              </button>
            </div>
          </div>

          <p
            className={cx(
              "mt-2 text-[11px]",
              tooMany ? "font-medium text-rose-700" : "text-slate-500",
            )}
            role={tooMany ? "alert" : undefined}
          >
            {tooMany
              ? `Only ${ceiling} ${unitWord(unit, ceiling)} available${chosen ? ` in batch ${chosen.batchNumber}` : ""}.`
              : !Number.isFinite(parsed) || parsed < 1
                ? "Enter a whole quantity of 1 or more."
                : chosen
                  ? `Taking ${parsed} from batch ${chosen.batchNumber}, expiring ${formatExpiry(chosen.expiryDate)} · ${describeExpiry(chosen.daysRemaining)}.`
                  : "Batches are drawn earliest expiry first. Enter adds the item."}
          </p>
        </>
      )}
    </div>
  );
}

/** A radio dot drawn rather than an <input>, so the whole row stays one button. */
function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ring-1",
        on ? "bg-brand-600 ring-brand-600" : "bg-white ring-slate-300",
      )}
    >
      {on ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
    </span>
  );
}
