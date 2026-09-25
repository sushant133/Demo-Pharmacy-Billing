"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatExpiry, integer, money } from "@/lib/format";
import {
  ADJUSTMENT_REASONS,
  MOVEMENT_REASON_LABELS,
  WRITE_OFF_REASONS,
  type MovementReason,
} from "@/lib/movement-kinds";
import { Card, cx } from "@/components/ui";

/**
 * The one form behind stock adjustment, write-off and transfer.
 *
 * All three are the same act with a different consequence: find the lot, say
 * how many units, say why. Writing it three times would have produced three
 * lot pickers that drift apart, so the differences are a `mode` and the rest
 * is shared - which is also why the three screens feel like one tool.
 *
 * Nothing here decides whether a move is allowed. The server re-checks the
 * count under a guarded update, because between picking a lot and pressing the
 * button somebody at the till may have sold the last box.
 */

export type StockActionMode = "adjust" | "damage" | "transfer";

interface Lot {
  id: string;
  branchId: string;
  medicineId: string;
  medicineName: string;
  genericName: string;
  unit: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  costPrice: number;
  salePrice: number;
  expired: boolean;
  daysRemaining: number;
}

export interface BranchOption {
  id: string;
  name: string;
}

interface Outcome {
  medicineName: string;
  batchNumber: string;
  quantity: number;
  direction: "in" | "out";
  balanceAfter: number;
  value: number;
  toBranchName?: string;
  transferRef?: string;
}

const COPY: Record<
  StockActionMode,
  {
    action: string;
    busy: string;
    heading: string;
    blurb: string;
    /** Heading for step 2, in the words of the job this mode is doing. */
    step2: string;
  }
> = {
  adjust: {
    action: "Apply correction",
    busy: "Correcting…",
    heading: "Correct a count",
    blurb:
      "Enter what you physically counted. The difference is recorded against the lot with your name and reason on it.",
    step2: "Record the count",
  },
  damage: {
    action: "Write off units",
    busy: "Writing off…",
    heading: "Write off stock",
    blurb:
      "Take broken, spoiled, expired or recalled units off the shelf. The loss is booked at what the stock cost.",
    step2: "Record the write-off",
  },
  transfer: {
    action: "Send units",
    busy: "Transferring…",
    heading: "Move stock to another branch",
    blurb:
      "Units leave the lot at this branch and arrive as a lot at the destination, keeping their expiry and cost.",
    step2: "Record the transfer",
  },
};

export function StockActionForm({
  mode,
  branches = [],
  initialQuery = "",
}: {
  mode: StockActionMode;
  /** Every open branch, for the transfer destination. Ignored otherwise. */
  branches?: BranchOption[];
  /**
   * Lot search to open with, carried from wherever the user pressed Adjust.
   *
   * Arriving from a medicine row with a blank search box means typing the name
   * that was under the cursor a second ago. The search still runs normally, so
   * this only saves the typing - it does not preselect a lot, because which
   * lot is being corrected is exactly the thing nobody else can decide.
   */
  initialQuery?: string;
}) {
  const router = useRouter();
  const copy = COPY[mode];

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Lot[]>([]);
  const [searching, setSearching] = useState(false);
  const [lot, setLot] = useState<Lot | null>(null);

  const [quantity, setQuantity] = useState("");
  const [reasonCode, setReasonCode] = useState<MovementReason>(
    mode === "adjust" ? "stock-take" : "expired",
  );
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [toBranchId, setToBranchId] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);
  const inflight = useRef(false);

  /*
    Lot search.

    Expired lots are included deliberately - writing one off is the single most
    common reason to open this screen, and a picker that hid them would send
    people to the database instead. Sold-out lots are not: there is nothing to
    move, and they would bury the ones there is.
  */
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await apiFetch<Lot[]>(
        `/api/batches?q=${encodeURIComponent(term)}&status=in-stock&pageSize=20`,
      );
      setSearching(false);
      if (result.ok) setResults(result.data);
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const reasons = mode === "adjust" ? ADJUSTMENT_REASONS : WRITE_OFF_REASONS;

  const reset = useCallback(() => {
    setLot(null);
    setQuery("");
    setResults([]);
    setQuantity("");
    setReason("");
    setNote("");
    setToBranchId("");
    setError(null);
    setDone(null);
    setConfirming(false);
  }, []);

  function pick(next: Lot) {
    setLot(next);
    setResults([]);
    setQuery("");
    setError(null);
    // An adjustment starts from what the system believes, so the box shows the
    // figure being corrected rather than an empty field to guess into.
    setQuantity(mode === "adjust" ? String(next.quantity) : "");
    if (mode === "damage" && next.expired) setReasonCode("expired");
  }

  const typed = Number(quantity);
  const validQuantity =
    quantity.trim() !== "" && Number.isInteger(typed) && typed >= 0;

  const delta = lot && mode === "adjust" ? typed - lot.quantity : 0;

  const canSubmit = Boolean(
    lot &&
      validQuantity &&
      !busy &&
      (mode === "adjust"
        ? delta !== 0
        : typed > 0 && lot && typed <= lot.quantity) &&
      (mode !== "transfer" || toBranchId),
  );

  async function submit() {
    if (!lot || inflight.current || !canSubmit) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const endpoint =
      mode === "adjust"
        ? "/api/inventory/adjustments"
        : mode === "damage"
          ? "/api/inventory/damaged"
          : "/api/inventory/transfers";

    const body =
      mode === "adjust"
        ? {
            batchId: lot.id,
            countedQuantity: typed,
            reasonCode,
            reason: reason.trim() || undefined,
            note: note.trim() || undefined,
          }
        : mode === "damage"
          ? {
              batchId: lot.id,
              quantity: typed,
              reasonCode,
              reason: reason.trim() || undefined,
              note: note.trim() || undefined,
            }
          : {
              batchId: lot.id,
              toBranchId,
              quantity: typed,
              reason: reason.trim() || undefined,
              note: note.trim() || undefined,
            };

    const result = await apiFetch<Outcome>(endpoint, { method: "POST", json: body });

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      // Back to the form, not stuck on a confirmation the server refused.
      setConfirming(false);
      return;
    }

    setDone(result.data);
    // The ledger under this form is now stale, and so is every stock figure
    // on the page.
    router.refresh();
  }

  // Transfers can only go somewhere else, so the branch holding the lot is not
  // offered as a destination.
  const destinations = branches.filter((branch) => branch.id !== lot?.branchId);

  /*
    The receipt. A tick beside the headline, because the one thing somebody
    needs from this card before they read a word of it is "it went through" -
    and on a green panel that is a shape, not a sentence.
  */
  if (done) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/60 p-5">
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
            aria-hidden="true"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.4}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-emerald-900">
              {mode === "transfer"
                ? `${integer(done.quantity)} sent to ${done.toBranchName}`
                : mode === "damage"
                  ? `${integer(done.quantity)} written off`
                  : `Count corrected by ${done.direction === "in" ? "+" : "−"}${integer(done.quantity)}`}
            </h2>
            <p className="mt-1 text-sm text-emerald-800">
              {done.medicineName} · lot {done.batchNumber} · {money(done.value)} at
              cost. The lot now reads {integer(done.balanceAfter)}.
            </p>
            {done.transferRef ? (
              <p className="mt-1 font-mono text-xs text-emerald-700">
                Reference {done.transferRef}
              </p>
            ) : null}
            <button type="button" onClick={reset} className="btn-primary mt-4">
              Record another
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-slate-900">{copy.heading}</h2>
      <p className="mt-1 mb-4 text-xs text-slate-600">{copy.blurb}</p>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {/*
        Two numbered steps, because this screen is two decisions - which lot,
        and what happened to it - and the second is meaningless until the first
        is settled. Unnumbered, it read as one long column of inputs where the
        search box at the top looked like just another field.
      */}
      {!lot ? (
        <div>
          <StepHead n={1}>Find the lot</StepHead>

          {/* The one field on this screen anybody types into cold. */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                d="M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              id="lot-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Medicine name or batch number"
              autoComplete="off"
              aria-label="Find the lot"
              className="input py-3 pl-11 text-base"
            />
          </div>

          {searching ? (
            <p className="mt-2 text-xs text-slate-500">Searching…</p>
          ) : null}

          {results.length > 0 ? (
            /*
              A result is a card rather than a table row, and the count sits
              under the batch line instead of hard against the right edge -
              on a full-width form that gap ran half the screen, so the number
              and the lot it belonged to were nowhere near each other.
            */
            <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
              {results.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => pick(row)}
                    className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-brand-200 hover:bg-brand-50"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-semibold text-brand-800"
                      aria-hidden="true"
                    >
                      {row.medicineName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">
                        {row.medicineName}
                      </span>
                      <span className="block font-mono text-[11px] text-slate-500">
                        {row.batchNumber} · exp {formatExpiry(row.expiryDate)}
                      </span>
                      <span className="tnum block text-[11px] text-slate-500">
                        {integer(row.quantity)}{" "}
                        {row.expired ? (
                          <span className="font-medium text-rose-600">expired</span>
                        ) : (
                          row.unit
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim().length >= 2 && !searching ? (
            <p className="mt-2 text-xs text-slate-500">
              No lot with stock matches that. Sold-out lots are not listed.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          {/*
            The lot in hand, so nobody adjusts the wrong one. Tinted rather
            than grey: it is the answer to step 1 and the subject of every
            field below it, not a disabled field.
          */}
          <div>
            <StepHead n={1}>Find the lot</StepHead>
            <div className="flex items-start justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {lot.medicineName}
                </p>
                <p className="font-mono text-[11px] text-slate-500">
                  {lot.batchNumber} · exp {formatExpiry(lot.expiryDate)}
                  {lot.expired ? " · expired" : ""}
                </p>
                <p className="tnum mt-1 text-xs text-slate-600">
                  {integer(lot.quantity)} {lot.unit} on hand · {money(lot.costPrice)}{" "}
                  each at cost
                </p>
              </div>
              <button
                type="button"
                onClick={reset}
                className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-slate-50"
              >
                Change
              </button>
            </div>
          </div>

          <div>
            <StepHead n={2}>{copy.step2}</StepHead>
            <div className="space-y-4">

              {mode === "transfer" ? (
                <div>
                  <label htmlFor="toBranch" className="label">
                    Send to
                  </label>
                  <select
                    id="toBranch"
                    value={toBranchId}
                    onChange={(event) => setToBranchId(event.target.value)}
                    className="input"
                  >
                    <option value="">Choose a branch…</option>
                    {destinations.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                  {destinations.length === 0 ? (
                    <p className="mt-1 text-xs text-amber-700">
                      There is no other open branch to send stock to.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/*
                System → counted → difference, as three figures rather than a
                sentence underneath the box.

                A stock-take is arithmetic done standing at a shelf, and the number
                that matters is the one nobody types: the difference. Spelling out
                what the system currently believes, beside what was counted, beside
                what that changes, is what lets somebody catch "I typed the
                difference, not the count" before they save it - which is the
                commonest way this screen gets used wrongly.
              */}
              {mode === "adjust" ? (
                /*
                  Set in a tray of its own so the three read as one sum being
                  worked, rather than three more boxes in a column of boxes.
                */
                <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-2.5">
                  <CountTile label="System says" value={integer(lot.quantity)} />
                  <CountTile
                    label="You counted"
                    value={validQuantity ? integer(typed) : "—"}
                    tone="brand"
                  />
                  <CountTile
                    label="Difference"
                    value={
                      !validQuantity
                        ? "—"
                        : delta === 0
                          ? "0"
                          : `${delta > 0 ? "+" : "−"}${integer(Math.abs(delta))}`
                    }
                    tone={
                      !validQuantity || delta === 0
                        ? "slate"
                        : delta > 0
                          ? "green"
                          : "amber"
                    }
                  />
                </div>
              ) : null}

              <div>
                <label htmlFor="quantity" className="label">
                  {mode === "adjust" ? "Counted quantity" : "Units"}
                </label>
                <input
                  id="quantity"
                  type="number"
                  inputMode="numeric"
                  min={mode === "adjust" ? 0 : 1}
                  max={mode === "adjust" ? undefined : lot.quantity}
                  step={1}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  /* The one number anybody types here, sized to say so. */
                  className="input tnum py-2.5 text-base font-semibold"
                />
                {mode === "adjust" ? (
                  <p
                    className={cx(
                      "mt-1 text-xs",
                      delta === 0
                        ? "text-slate-500"
                        : delta > 0
                          ? "font-medium text-emerald-700"
                          : "font-medium text-amber-700",
                    )}
                  >
                    {!validQuantity
                      ? "Count in whole units."
                      : delta === 0
                        ? "Same as the system count - nothing to correct."
                        : `${delta > 0 ? "Adds" : "Removes"} ${integer(Math.abs(delta))} ${lot.unit}, worth ${money(Math.abs(delta) * lot.costPrice)} at cost.`}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">
                    {validQuantity && typed > lot.quantity
                      ? `Only ${integer(lot.quantity)} on hand.`
                      : validQuantity && typed > 0
                        ? `${money(typed * lot.costPrice)} at cost. The lot will read ${integer(lot.quantity - typed)}.`
                        : `Up to ${integer(lot.quantity)} ${lot.unit}.`}
                  </p>
                )}
              </div>

              {/*
                The canned reason and the free-text detail are one thought -
                "why" in a dropdown, then "why exactly" beside it - so they
                share a row wherever there is width for two. That takes a
                column of six stacked fields down to four.
              */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {mode !== "transfer" ? (
                  <div className="min-w-0">
                    <label htmlFor="reasonCode" className="label">
                      Reason
                    </label>
                    <select
                      id="reasonCode"
                      value={reasonCode}
                      onChange={(event) =>
                        setReasonCode(event.target.value as MovementReason)
                      }
                      className="input"
                    >
                      {reasons.map((value) => (
                        <option key={value} value={value}>
                          {MOVEMENT_REASON_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div
                  className={cx("min-w-0", mode === "transfer" && "sm:col-span-2")}
                >
                  <label htmlFor="reason" className="label">
                    {mode === "transfer" ? "Why it is being moved" : "Detail"}
                    <span className="ml-1 font-normal text-slate-400">
                      {reasonCode === "other" && mode !== "transfer"
                        ? "(required)"
                        : "(optional)"}
                    </span>
                  </label>
                  <input
                    id="reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={300}
                    placeholder={
                      mode === "transfer"
                        ? "e.g. covering a shortage at the other counter"
                        : "e.g. two strips crushed in the delivery crate"
                    }
                    className="input"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="note" className="label">
                  Note <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <textarea
                  id="note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={300}
                  rows={2}
                  className="input"
                />
              </div>

              {/*
                One look before it is written.

                A movement is append-only: a wrong correction is fixed by making
                another one, which leaves both on the lot's history forever. That
                makes the cost of a slip a permanent line in an audit trail rather
                than an undo, and it is worth one confirm - restating the lot, the
                change and the reason, because those are three sections apart on
                the form by the time somebody reaches this button.
              */}
              {confirming ? (
                <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3">
                  <p className="text-sm font-medium text-slate-900">
                    {mode === "adjust"
                      ? delta > 0
                        ? `Add ${integer(Math.abs(delta))} ${lot.unit} to this lot?`
                        : `Remove ${integer(Math.abs(delta))} ${lot.unit} from this lot?`
                      : mode === "damage"
                        ? `Write off ${integer(typed)} ${lot.unit}?`
                        : `Send ${integer(typed)} ${lot.unit} to another branch?`}
                  </p>

                  <dl className="mt-2 space-y-1 border-y border-brand-200/60 py-2">
                    <ConfirmRow
                      label="Lot"
                      value={`${lot.medicineName} · ${lot.batchNumber}`}
                    />
                    {mode === "adjust" ? (
                      <ConfirmRow
                        label="Count"
                        value={`${integer(lot.quantity)} → ${integer(typed)} ${lot.unit}`}
                      />
                    ) : (
                      <ConfirmRow
                        label="Lot afterwards"
                        value={`${integer(lot.quantity - typed)} ${lot.unit}`}
                      />
                    )}
                    {mode !== "transfer" ? (
                      <ConfirmRow
                        label="Reason"
                        value={MOVEMENT_REASON_LABELS[reasonCode]}
                      />
                    ) : null}
                    {reason.trim() ? (
                      <ConfirmRow label="Detail" value={reason.trim()} />
                    ) : null}
                    <ConfirmRow
                      label="Value at cost"
                      value={money(
                        Math.abs(mode === "adjust" ? delta : typed) * lot.costPrice,
                      )}
                    />
                  </dl>

                  <p className="mt-2 text-[11px] text-slate-500">
                    This is recorded against the lot with your name on it and cannot
                    be edited afterwards - a mistake is corrected by another entry.
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
                      className={cx(
                        "flex-[2]",
                        mode === "damage" ? "btn-danger" : "btn-primary",
                      )}
                    >
                      {busy ? copy.busy : copy.action}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={!canSubmit}
                    className={cx(
                      "flex-1",
                      mode === "damage" ? "btn-danger" : "btn-primary",
                    )}
                  >
                    {copy.action}
                  </button>
                  <button type="button" onClick={reset} className="btn-secondary">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * A numbered step heading.
 *
 * The same teal disc the returns screen uses for its steps, so the two places
 * in this app that walk somebody through a sequence look like the same idea.
 */
function StepHead({ n, children }: { n: number; children: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
        {n}
      </span>
      <h3 className="text-sm font-semibold text-slate-900">{children}</h3>
    </div>
  );
}

/** One of the three figures in the count strip. */
function CountTile({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: "slate" | "brand" | "green" | "amber";
}) {
  return (
    <div
      className={cx(
        "rounded-lg border px-2.5 py-2.5 text-center",
        tone === "brand"
          ? "border-brand-200 bg-brand-50"
          : tone === "green"
            ? "border-emerald-200 bg-emerald-50"
            : tone === "amber"
              ? "border-amber-200 bg-amber-50"
              : "border-slate-200 bg-white",
      )}
    >
      <p className="text-[10px] font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </p>
      <p
        className={cx(
          "tnum mt-0.5 text-2xl font-semibold tracking-tight",
          tone === "green"
            ? "text-emerald-700"
            : tone === "amber"
              ? "text-amber-700"
              : "text-slate-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** A label/value line in the confirmation summary. */
function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-slate-800">
        {value}
      </dd>
    </div>
  );
}
