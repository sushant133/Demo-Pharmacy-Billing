import Link from "next/link";
import { config } from "@/lib/config";
import { formatDateTime, formatExpiry, integer, money } from "@/lib/format";
import { MOVEMENT_KIND_LABELS, type MovementKind } from "@/lib/movement-kinds";
import type { LedgerEntry } from "@/lib/stock-ledger";
import { MovementDetail } from "@/components/inventory/MovementDetail";
import { Badge, Card, EmptyState, Pagination, TableWrap, cx } from "@/components/ui";

/**
 * The dated list every stock-movement screen shows.
 *
 * Shared so the five screens cannot disagree about what a movement looks like
 * - and because they are genuinely the same list, filtered differently: stock
 * in is everything arriving, adjustments are one kind of it, and both want the
 * same columns in the same order.
 */

/** The badge tone for each kind: arriving is green, leaving is amber or rose. */
const KIND_TONE: Record<MovementKind, "green" | "amber" | "rose" | "slate" | "brand"> = {
  purchase: "green",
  "sale-return": "green",
  "transfer-in": "brand",
  sale: "slate",
  "transfer-out": "brand",
  adjustment: "amber",
  // Goods going back to the supplier: routine, not a loss. Amber rather than
  // the rose a write-off gets, because the shop is credited for these.
  "purchase-return": "amber",
  damage: "rose",
};

export function StockLedger({
  entries,
  page,
  pageSize,
  total,
  baseHref,
  canSeeMoney,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: {
  /** Only the rows for this page; the caller slices. */
  entries: LedgerEntry[];
  page: number;
  pageSize: number;
  total: number;
  baseHref: string;
  canSeeMoney: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: React.ReactNode;
}) {
  if (entries.length === 0) {
    return (
      <Card className="overflow-hidden">
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <TableWrap minWidth="58rem" pinFirst>
        <thead>
          <tr>
            <th className="th">When</th>
            <th className="th">Movement</th>
            <th className="th">Medicine</th>
            <th className="th">Lot & expiry</th>
            <th className="th">Supplier</th>
            <th className="th text-right">Units</th>
            {canSeeMoney ? (
              <>
                <th className="th text-right">Unit cost</th>
                <th className="th text-right">Value</th>
              </>
            ) : null}
            <th className="th">Reference</th>
            <th className="th">By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((entry) => {
            const expiry = expiryState(entry.expiryDate);

            return (
            <MovementDetail
              key={entry.id}
              data={{
                id: entry.id,
                at: formatDateTime(entry.at),
                kindLabel: MOVEMENT_KIND_LABELS[entry.kind],
                direction: entry.direction,
                medicineName: entry.medicineName,
                batchNumber: entry.batchNumber,
                expiryLabel: entry.expiryDate ? formatExpiry(entry.expiryDate) : "",
                expiryTone: expiry.tone,
                expiryStatus: expiry.label,
                unit: entry.unit,
                quantity: entry.quantity,
                unitCost: money(entry.unitCost),
                value: money(entry.value),
                balanceAfter: entry.balanceAfter,
                branchName: entry.branchName,
                supplier: entry.supplier,
                reference: entry.reference,
                referenceHref: entry.referenceHref,
                reason: entry.reason,
                note: entry.note,
                by: entry.by,
                canSeeMoney,
              }}
            >
              <td className="td tnum whitespace-nowrap text-slate-600">
                {formatDateTime(entry.at)}
              </td>

              <td className="td">
                <Badge tone={KIND_TONE[entry.kind]}>
                  {MOVEMENT_KIND_LABELS[entry.kind]}
                </Badge>
                {entry.reason ? (
                  <span className="mt-0.5 block max-w-[14rem] truncate text-[11px] text-slate-500">
                    {entry.reason}
                  </span>
                ) : null}
              </td>

              <td className="td">
                <span className="block max-w-[14rem] truncate font-medium text-slate-900">
                  {entry.medicineName}
                </span>
                {/* The lot, folded in where its own column is hidden. */}
                <span className="block font-mono text-[11px] text-slate-400 lg:hidden">
                  {entry.batchNumber}
                </span>
              </td>

              <td className="td">
                <span className="block font-mono text-xs text-slate-600">
                  {entry.batchNumber || "—"}
                </span>
                {entry.expiryDate ? (
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="tnum text-[11px] text-slate-500">
                      {formatExpiry(entry.expiryDate)}
                    </span>
                    {/*
                      Only said when it needs saying. A badge on every row -
                      including the two years of lots that are perfectly fine -
                      is a column of noise the eye stops reading, which is
                      exactly when it stops catching the expired one.
                    */}
                    {expiry.status !== "ok" ? (
                      <Badge tone={expiry.tone}>{expiry.label}</Badge>
                    ) : null}
                  </span>
                ) : null}
              </td>

              <td className="td">
                <span className="block max-w-[12rem] truncate text-xs text-slate-600">
                  {entry.supplier || (
                    // Blank is meaningful, not missing: a customer return and a
                    // stock-take have no supplier in them.
                    <span className="text-slate-300">—</span>
                  )}
                </span>
              </td>

              <td className="td text-right">
                {/*
                  Signed, because a list mixing arrivals and departures is
                  unreadable without it - and an adjustment is the one kind
                  that can be either.
                */}
                <span
                  className={cx(
                    "tnum font-semibold",
                    entry.direction === "in" ? "text-emerald-700" : "text-slate-900",
                  )}
                >
                  {entry.direction === "in" ? "+" : "−"}
                  {integer(entry.quantity)}
                </span>
                {entry.balanceAfter != null ? (
                  <span className="tnum block text-[11px] text-slate-400">
                    lot left {integer(entry.balanceAfter)}
                  </span>
                ) : null}
              </td>

              {canSeeMoney ? (
                <>
                  <td className="td tnum text-right text-slate-500">
                    {money(entry.unitCost)}
                  </td>
                  <td className="td tnum text-right text-slate-700">
                    {money(entry.value)}
                  </td>
                </>
              ) : null}

              <td className="td">
                {entry.reference ? (
                  entry.referenceHref ? (
                    <Link
                      href={entry.referenceHref}
                      className="font-mono text-xs text-brand-700 hover:underline"
                    >
                      {entry.reference}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs text-slate-600">
                      {entry.reference}
                    </span>
                  )
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>

              <td className="td text-slate-600">
                {entry.by || "—"}
              </td>
            </MovementDetail>
            );
          })}
        </tbody>
      </TableWrap>

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / pageSize))}
        total={total}
        baseHref={baseHref}
      />
    </Card>
  );
}

/**
 * What state a lot's expiry is in, for the badge beside it.
 *
 * Graded on the same threshold the alerts screen uses, so a lot the alert
 * centre calls "expiring soon" is not described differently here. A movement
 * with no expiry - a transfer reference, an older adjustment - is "slate" and
 * says nothing, rather than being reported as fine.
 */
function expiryState(expiryDate: Date | null): {
  status: "ok" | "expiring" | "expired" | "unknown";
  label: string;
  tone: "green" | "amber" | "rose" | "slate";
} {
  if (!expiryDate) {
    return { status: "unknown", label: "No expiry", tone: "slate" };
  }

  const days = Math.floor(
    (new Date(expiryDate).getTime() - Date.now()) / 86_400_000,
  );

  if (days < 0) return { status: "expired", label: "Expired", tone: "rose" };
  if (days <= config.expiryAlertDays) {
    return { status: "expiring", label: `${days}d left`, tone: "amber" };
  }
  return { status: "ok", label: "In date", tone: "green" };
}
