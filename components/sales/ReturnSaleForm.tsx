"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { money } from "@/lib/format";
import { describeQuantity, formatUnitCount, stripLabel, unitWord } from "@/lib/pack";

interface ReturnLine {
  lineIndex: number;
  medicineName: string;
  batchNumber: string;
  quantity: number;
  remaining: number;
  unitPrice: number;
  unit: string;
  unitsPerStrip: number;
}

interface ReturnResult {
  billNo: string;
  units: number;
  totalAmount: number;
  restored: Array<{ batchNumber: string; quantity: number }>;
  unreturned: Array<{ batchNumber: string; quantity: number }>;
}

export function ReturnSaleForm({
  saleId,
  billNo,
  lines,
}: {
  saleId: string;
  billNo: string;
  lines: ReturnLine[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const inflight = useRef(false);

  const chosen = useMemo(
    () =>
      lines
        .map((line) => ({
          lineIndex: line.lineIndex,
          quantity: Math.max(0, Math.floor(Number(qty[line.lineIndex] || 0))),
          remaining: line.remaining,
        }))
        .filter((entry) => entry.quantity > 0),
    [lines, qty],
  );

  const invalid = chosen.some((entry) => entry.quantity > entry.remaining);

  function setLineQty(lineIndex: number, remaining: number, value: number) {
    const next = Math.max(0, Math.min(remaining, Math.floor(value) || 0));
    setQty((current) => ({
      ...current,
      [lineIndex]: next === 0 ? "" : String(next),
    }));
  }

  async function submit() {
    if (inflight.current || chosen.length === 0 || invalid) return;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch<ReturnResult>(`/api/sales/${saleId}/return`, {
      method: "POST",
      json: {
        items: chosen.map(({ lineIndex, quantity }) => ({ lineIndex, quantity })),
        reason: reason.trim(),
      },
    });

    if (!result.ok) {
      inflight.current = false;
      setError(result.message);
      setBusy(false);
      return;
    }

    if (result.data.unreturned.length > 0) {
      const lots = result.data.unreturned
        .map((entry) => `${entry.batchNumber} (${entry.quantity})`)
        .join(", ");
      setWarning(
        `Returned, but these lots no longer exist so their units could not go back on the shelf: ${lots}. Correct the stock manually.`,
      );
    }

    setOpen(false);
    setQty({});
    setReason("");
    inflight.current = false;
    setBusy(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="space-y-2">
        {warning ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {warning}
          </div>
        ) : null}
        <button type="button" onClick={() => setOpen(true)} className="btn-secondary w-full">
          Record a return
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <p className="text-xs text-slate-600">
        Type how many came back — 6 tablets from a strip of 10 is fine. They go
        to the same batches on {billNo}.
      </p>

      <ul className="space-y-2">
        {lines.map((line) => {
          const perStrip = line.unitsPerStrip || 1;
          const typed = Math.max(0, Math.floor(Number(qty[line.lineIndex] || 0)));
          const pack = stripLabel(perStrip, line.unit);
          const alreadyBack = line.quantity - line.remaining;
          return (
            <li
              key={line.lineIndex}
              className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5"
            >
              <p className="text-sm font-medium text-slate-900">{line.medicineName}</p>
              <p className="text-[11px] text-slate-500">
                {line.batchNumber} · {money(line.unitPrice)} each
                {pack ? ` · ${pack}` : ""}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Sold {formatUnitCount(line.quantity, line.unit)}
                {alreadyBack > 0
                  ? ` · ${formatUnitCount(alreadyBack, line.unit)} already back`
                  : ""}
                {" · "}
                {formatUnitCount(line.remaining, line.unit)} still with customer
              </p>

              {line.remaining <= 0 ? (
                <p className="mt-2 text-xs text-slate-500">Nothing left to return.</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                      Return {unitWord(line.unit, 2)}
                    </span>
                    <div className="flex items-center rounded-xl bg-white ring-1 ring-slate-200 ring-inset">
                      <button
                        type="button"
                        aria-label={`Fewer ${line.medicineName}`}
                        onClick={() => setLineQty(line.lineIndex, line.remaining, typed - 1)}
                        className="px-2.5 py-1 text-slate-500 hover:text-slate-900"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={line.remaining}
                        step={1}
                        value={qty[line.lineIndex] ?? ""}
                        onChange={(event) =>
                          setQty((current) => ({
                            ...current,
                            [line.lineIndex]: event.target.value,
                          }))
                        }
                        onBlur={(event) =>
                          setLineQty(
                            line.lineIndex,
                            line.remaining,
                            Number(event.target.value),
                          )
                        }
                        placeholder="0"
                        className="tnum w-14 border-0 bg-transparent py-1 text-center text-sm font-semibold focus:ring-0 focus:outline-none"
                        aria-label={`How many ${unitWord(line.unit, 2)} of ${line.medicineName} to return`}
                      />
                      <button
                        type="button"
                        aria-label={`More ${line.medicineName}`}
                        onClick={() => setLineQty(line.lineIndex, line.remaining, typed + 1)}
                        className="px-2.5 py-1 text-slate-500 hover:text-slate-900"
                      >
                        +
                      </button>
                    </div>
                    {perStrip > 1 && line.remaining >= perStrip ? (
                      <button
                        type="button"
                        onClick={() =>
                          setLineQty(line.lineIndex, line.remaining, typed + perStrip)
                        }
                        className="rounded-md bg-white px-1.5 py-1 text-[10px] font-medium text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-50"
                      >
                        + 1 strip ({perStrip})
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setLineQty(line.lineIndex, line.remaining, line.remaining)
                      }
                      className="rounded-md bg-white px-1.5 py-1 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50"
                    >
                      All {line.remaining}
                    </button>
                  </div>
                  {typed > 0 ? (
                    <p className="mt-1.5 text-xs text-slate-600">
                      {describeQuantity(typed, perStrip, line.unit)} coming back
                      {typed < line.remaining
                        ? ` · ${formatUnitCount(line.remaining - typed, line.unit)} stay with the customer`
                        : ""}
                    </p>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>

      <label htmlFor="return-reason" className="label">
        Reason
      </label>
      <input
        id="return-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. customer returned 6 tablets unused"
        className="input text-xs"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || chosen.length === 0 || invalid || reason.trim().length < 3}
          className="btn-primary flex-1 py-1.5 text-xs"
        >
          {busy ? "Recording…" : "Return to stock"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn-secondary py-1.5 text-xs"
        >
          Back
        </button>
      </div>
    </div>
  );
}
