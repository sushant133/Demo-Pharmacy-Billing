"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, cx } from "@/components/ui";

/**
 * One movement, opened from its row.
 *
 * The ledger table is deliberately narrow - a month of receipts has to be
 * scannable - so several facts about each movement have nowhere to live in it:
 * the reason typed at the time, the note beside it, the running balance the lot
 * was left at, which branch it happened in. Those are exactly what somebody
 * asks for when they stop scanning and start investigating one row, which is
 * what this is.
 *
 * It reads only what the row already carries. No fetch, no loading state, no
 * second version of the truth - if the table has it, the panel shows it, and
 * the panel cannot disagree with the row it came from.
 */

export interface MovementDetailData {
  id: string;
  at: string;
  kindLabel: string;
  direction: "in" | "out";
  medicineName: string;
  batchNumber: string;
  expiryLabel: string;
  expiryTone: "green" | "amber" | "rose" | "slate";
  expiryStatus: string;
  unit: string;
  quantity: number;
  unitCost: string;
  value: string;
  balanceAfter: number | null;
  branchName: string;
  supplier: string;
  reference: string;
  referenceHref: string | null;
  reason: string;
  note: string;
  by: string;
  canSeeMoney: boolean;
}

export function MovementDetail({
  data,
  children,
}: {
  data: MovementDetailData;
  /** The row's cells, rendered inside the clickable <tr>. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Escape closes, and the body stops scrolling behind the panel. Both are
  // what a dialog is expected to do, and neither is worth a library.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  function onRowClick(event: React.MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement | null;
    // The reference is a real link to the GRN or bill; let it win.
    if (target?.closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    setOpen(true);
  }

  return (
    <>
      <tr
        onClick={onRowClick}
        className="cursor-pointer transition-colors hover:bg-brand-50/50"
      >
        {children}
      </tr>

      {open ? (
        <tr>
          {/*
            A dialog cannot be a child of <tbody>, so it is portalled visually
            by being fixed-position inside a full-width cell. `colSpan` keeps
            the table markup valid, which matters because an invalid table is
            one browsers silently reflow.
          */}
          <td colSpan={99} className="p-0">
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`${data.kindLabel}: ${data.medicineName}`}
              className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
            >
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]"
              />

              <div className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={data.direction === "in" ? "green" : "amber"}>
                        {data.kindLabel}
                      </Badge>
                      <span className="text-xs text-slate-500">{data.at}</span>
                    </div>
                    <p className="mt-1.5 truncate text-base font-semibold text-slate-900">
                      {data.medicineName}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="btn-ghost -mt-1 -mr-2 shrink-0 px-2 py-2"
                    aria-label="Close"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div className="px-5 py-4">
                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <Figure
                      label={data.direction === "in" ? "Units in" : "Units out"}
                      value={`${data.direction === "in" ? "+" : "−"}${data.quantity} ${data.unit}`}
                      tone={data.direction === "in" ? "green" : "amber"}
                    />
                    {data.canSeeMoney ? (
                      <Figure label="Value at cost" value={data.value} />
                    ) : null}
                  </div>

                  <dl className="divide-y divide-slate-100">
                    <Row label="Lot">
                      <span className="font-mono text-slate-800">
                        {data.batchNumber || "—"}
                      </span>
                    </Row>
                    <Row label="Expiry">
                      {data.expiryLabel ? (
                        <span className="flex items-center justify-end gap-2">
                          <span className="tnum text-slate-800">
                            {data.expiryLabel}
                          </span>
                          <Badge tone={data.expiryTone}>{data.expiryStatus}</Badge>
                        </span>
                      ) : (
                        "—"
                      )}
                    </Row>
                    {data.canSeeMoney ? (
                      <Row label="Unit cost">
                        <span className="tnum">{data.unitCost}</span>
                      </Row>
                    ) : null}
                    {data.balanceAfter != null ? (
                      <Row label="Lot balance afterwards">
                        <span className="tnum">{data.balanceAfter}</span>
                      </Row>
                    ) : null}
                    {data.supplier ? (
                      <Row label="Supplier">{data.supplier}</Row>
                    ) : null}
                    <Row label="Reference">
                      {data.reference ? (
                        data.referenceHref ? (
                          <Link
                            href={data.referenceHref}
                            className="font-mono font-medium text-brand-700 hover:underline"
                          >
                            {data.reference}
                          </Link>
                        ) : (
                          <span className="font-mono">{data.reference}</span>
                        )
                      ) : (
                        "—"
                      )}
                    </Row>
                    {data.branchName ? (
                      <Row label="Branch">{data.branchName}</Row>
                    ) : null}
                    {data.reason ? <Row label="Reason">{data.reason}</Row> : null}
                    {data.note ? <Row label="Note">{data.note}</Row> : null}
                    <Row label="Recorded by">{data.by || "—"}</Row>
                  </dl>
                </div>

                <div className="flex gap-2 border-t border-slate-100 px-5 py-3">
                  {data.referenceHref ? (
                    <Link href={data.referenceHref} className="btn-primary flex-1">
                      Open {data.reference}
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className={cx("btn-secondary", !data.referenceHref && "flex-1")}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Figure({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: "slate" | "green" | "amber";
}) {
  return (
    <div
      className={cx(
        "rounded-xl px-3 py-2.5",
        tone === "green"
          ? "bg-emerald-50"
          : tone === "amber"
            ? "bg-amber-50"
            : "bg-slate-50",
      )}
    >
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </p>
      <p
        className={cx(
          "tnum mt-0.5 text-lg font-semibold",
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right text-slate-800">{children}</dd>
    </div>
  );
}
