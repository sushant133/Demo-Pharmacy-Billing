import type { Metadata } from "next";
import Link from "next/link";
import { Types } from "mongoose";
import { requirePagePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import {
  addDays,
  dateRangeFromStrings,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { DualDateField } from "@/components/DualDateField";
import { formatDateTime, money } from "@/lib/format";
import { resolveUnitsPerStrip } from "@/lib/pack";
import { can } from "@/lib/roles";
import {
  REFUND_METHOD_LABELS,
  RETURN_REASONS,
  isRefundMethod,
  isReturnReason,
  returnEligibility,
} from "@/lib/return-eligibility";
import { pharmacyFilter } from "@/lib/tenant";
import { displayBillNo, storedBillNo } from "@/models/Counter";
import { Medicine } from "@/models/Medicine";
import { Sale } from "@/models/Sale";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  TableWrap,
} from "@/components/ui";
import {
  ReturnWorkflow,
  type ReturnableLine,
} from "@/components/sales/ReturnWorkflow";

export const metadata: Metadata = { title: "Returns" };
export const dynamic = "force-dynamic";

/**
 * Customer returns, end to end on one screen.
 *
 * Find the invoice, pick what is coming back, say why, read the refund,
 * confirm. It used to send the counter off to the invoice screen to do the
 * middle of that, which meant the person holding the medicine and the person
 * reading the refund were looking at two different pages.
 *
 * Only completed sales appear: a voided bill has already given its stock back,
 * and a draft is not a sale. Which *lines* may come back is decided by
 * `returnEligibility`, and the same rule runs again inside the transaction, so
 * nothing here is the only thing standing between an expired lot and a shelf.
 */
export default async function SalesReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    from?: string;
    to?: string;
    reason?: string;
    hq?: string;
  }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;
  await connectDB();

  const q = params.q?.trim() ?? "";
  const tenant = pharmacyFilter(user);
  const canRecord = can(user.role, "sale:void");
  const now = new Date();

  /*
    History filters live on their own query keys - `hq` for its search, not
    `q` - because `q` is the invoice lookup at the top of the page. Sharing
    one key would mean filtering the history re-ran the invoice search and
    scrolled the counter back to step 1 mid-task.

    The range defaults to the last 30 days rather than to today: a returns log
    showing nothing most mornings reads as broken, and "has this come back
    before?" is a question about the past few weeks.
  */
  const historyTo = params.to || toDateInputValue();
  const historyFrom =
    params.from ||
    toDateInputValue(addDays(parseLocalDate(historyTo) ?? new Date(), -30));
  const historyReason = isReturnReason(params.reason) ? params.reason : null;
  const historySearch = params.hq?.trim() ?? "";
  const canExport =
    can(user.role, "report:export") && can(user.role, "report:financial");

  const sale = q
    ? await Sale.findOne(
        Types.ObjectId.isValid(q)
          ? { _id: q, ...tenant }
          : { billNo: storedBillNo(q), ...tenant },
      ).lean()
    : null;

  // Pack sizes live on the catalogue, not the bill, so "+ 1 strip" knows how
  // many a strip is even for a medicine repriced since.
  const packs =
    sale && sale.items.length > 0
      ? await Medicine.find({
          ...tenant,
          _id: { $in: sale.items.map((item) => item.medicineId) },
        })
          .select("unit packSize unitsPerStrip")
          .lean()
      : [];
  const packById = new Map(packs.map((doc) => [String(doc._id), doc]));

  const lines: ReturnableLine[] =
    sale?.items.map((item, lineIndex) => {
      const pack = packById.get(String(item.medicineId));
      const unit = item.unit || pack?.unit || "unit";
      const eligibility = returnEligibility(
        {
          quantity: item.quantity,
          returnedQuantity: item.returnedQuantity ?? 0,
          expiryDate: item.expiryDate as unknown as Date,
          saleVoided: Boolean(sale.voidedAt),
        },
        now,
      );

      return {
        lineIndex,
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        expiryDate: new Date(item.expiryDate as unknown as Date).toISOString(),
        quantity: item.quantity,
        alreadyReturned: item.returnedQuantity ?? 0,
        returnable: eligibility.returnable,
        unitPrice: item.unitPrice,
        unit,
        unitsPerStrip: resolveUnitsPerStrip(
          unit,
          pack?.packSize ?? "",
          pack?.unitsPerStrip,
        ),
        eligible: eligibility.eligible,
        message: eligibility.message,
      };
    }) ?? [];

  const historyRange = dateRangeFromStrings(historyFrom, historyTo);
  const historyPattern = historySearch
    ? new RegExp(historySearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;

  // Return History: one row per return event, newest first, rather than one
  // row per bill - two returns on the same invoice are two things that
  // happened, and rolling them together hides the second.
  const history = await Sale.aggregate<{
    _id: Types.ObjectId;
    billNo: string;
    customerName: string;
    returnIndex: number;
    returnedAt: Date;
    returnedByName: string;
    reason: string;
    reasonCode: string;
    refundMethod: string;
    units: number;
    totalAmount: number;
    conditionConfirmed: boolean;
  }>([
    { $match: { ...tenant, "returns.0": { $exists: true } } },
    { $unwind: { path: "$returns", includeArrayIndex: "returnIndex" } },
    {
      $project: {
        billNo: 1,
        customerName: 1,
        customerPhone: 1,
        returnIndex: 1,
        returnedAt: "$returns.returnedAt",
        returnedByName: "$returns.returnedByName",
        reason: "$returns.reason",
        reasonCode: "$returns.reasonCode",
        refundMethod: "$returns.refundMethod",
        units: "$returns.units",
        totalAmount: "$returns.totalAmount",
        conditionConfirmed: "$returns.conditionConfirmed",
      },
    },
    /*
      Filtered after the unwind, not before. A `$match` on the array would
      keep every return on a *bill* that had one matching return - so
      narrowing to "damaged" would still list the unrelated return recorded
      against the same invoice last week.
    */
    {
      $match: {
        ...(historyRange.start || historyRange.end
          ? {
              returnedAt: {
                ...(historyRange.start ? { $gte: historyRange.start } : {}),
                ...(historyRange.end ? { $lt: historyRange.end } : {}),
              },
            }
          : {}),
        ...(historyReason ? { reasonCode: historyReason } : {}),
        ...(historySearch
          ? {
              $or: [
                { billNo: historyPattern },
                { customerName: historyPattern },
                { customerPhone: historyPattern },
                { reason: historyPattern },
                { returnedByName: historyPattern },
              ],
            }
          : {}),
      },
    },
    { $sort: { returnedAt: -1 } },
    { $limit: 100 },
  ]);

  const historyUnits = history.reduce((sum, row) => sum + (row.units ?? 0), 0);
  const historyRefunded = history.reduce(
    (sum, row) => sum + (row.totalAmount ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Returns"
        subtitle="Take back sealed, undamaged medicine from a completed sale and put it straight back on the shelf."
        actions={
          <Link href="/sales" className="btn-secondary">
            Sales register
          </Link>
        }
      />

      {/* ---- Step 1: find the invoice ---- */}
      <Card className="mb-4 p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
            1
          </span>
          <h2 className="text-sm font-semibold text-slate-900">Find the invoice</h2>
        </div>

        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <label htmlFor="q" className="label">
              Bill number
            </label>
            <input
              id="q"
              name="q"
              defaultValue={q}
              placeholder="INV-2083/84-000139"
              className="input"
              autoCapitalize="characters"
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn-primary">
            Find invoice
          </button>
          {q ? (
            <Link href="/sales/returns" className="btn-secondary">
              Clear
            </Link>
          ) : null}
        </form>

        {q && !sale ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            No invoice matches “{q}”. Check the number on the customer&apos;s copy.
          </p>
        ) : null}

        {sale ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3">
            <div className="min-w-0">
              <p className="font-mono text-sm font-semibold text-slate-900">
                {displayBillNo(sale.billNo)}
              </p>
              <p className="text-xs text-slate-500">
                {formatDateTime(sale.createdAt as unknown as Date)} ·{" "}
                {sale.customerName || "Walk-in"} · {money(sale.totalAmount)}
              </p>
            </div>
            {sale.voidedAt ? (
              <Badge tone="rose">Voided</Badge>
            ) : (sale.returnedUnits ?? 0) > 0 ? (
              <Badge tone="amber">
                {sale.returnedUnits} unit(s) already returned
              </Badge>
            ) : (
              <Badge tone="green">Completed sale</Badge>
            )}
          </div>
        ) : null}
      </Card>

      {/* ---- Steps 2-6 ---- */}
      {sale ? (
        sale.voidedAt ? (
          <Card className="mb-6 p-4 sm:p-5">
            <p className="text-sm text-slate-600">
              This invoice was voided, so every unit on it has already gone back
              to stock. There is nothing left to return.
            </p>
          </Card>
        ) : !canRecord ? (
          <Card className="mb-6 p-4 sm:p-5">
            <p className="text-sm text-slate-600">
              You can look invoices up, but recording a return needs the
              returns permission. Ask the pharmacy owner.
            </p>
          </Card>
        ) : (
          <Card className="mb-6 overflow-hidden">
            <ReturnWorkflow
              saleId={String(sale._id)}
              billNo={displayBillNo(sale.billNo)}
              lines={lines}
              // The bill's own discount rate, so a refund gives back what was
              // paid rather than the shelf price.
              discountRate={
                sale.subtotal > 0 ? (sale.discount ?? 0) / sale.subtotal : 0
              }
              vatRate={sale.vatRate ?? 0.13}
              // What is still owed on this bill before the return. Decides
              // whether "reduce what they owe" is a refund method on offer -
              // and the server re-checks it, so the screen cannot talk a
              // settled bill into an adjustment.
              outstanding={Math.max(
                0,
                Math.round(
                  (sale.totalAmount -
                    (sale.returnedTotal ?? 0) -
                    (sale.amountReceived ?? 0)) *
                    100,
                ) / 100,
              )}
            />
          </Card>
        )
      ) : null}

      {/* ---- Return history ---- */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-1">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">
              Return history
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {history.length === 0
                ? "Nothing in this range."
                : `${history.length} return${history.length === 1 ? "" : "s"} · ${historyUnits} unit${historyUnits === 1 ? "" : "s"} back · ${money(historyRefunded)} refunded`}
            </p>
          </div>

          {/*
            Export carries whatever the filters are set to, so what downloads
            is what is on screen. Gated on the financial permission as well as
            the export one: the register shows cost returned.
          */}
          {canExport ? (
            <div className="flex items-center gap-1.5">
              <ExportLink
                href={`/api/export?report=sales-returns&format=xlsx&from=${historyFrom}&to=${historyTo}`}
                label="Excel"
              />
              <ExportLink
                href={`/api/export?report=sales-returns&format=pdf&from=${historyFrom}&to=${historyTo}`}
                label="PDF"
              />
            </div>
          ) : null}
        </div>

        {/*
          Filters for the log, on their own query keys so narrowing the history
          never disturbs the invoice lookup in step 1 above.

          An inset tray rather than a tinted strip running edge to edge. The
          full-bleed version read as a second header bolted under the first;
          set in from the card's own margins it reads as what it is - a control
          belonging to the table directly beneath it.
        */}
        <form
          method="get"
          className="m-4 flex flex-wrap items-end gap-x-3 gap-y-3 rounded-xl bg-slate-50 p-3 sm:p-3.5"
        >
          {q ? <input type="hidden" name="q" value={q} /> : null}

          {/*
            Wider than the two dates would need on their own: each carries an
            AD box and a BS picker stacked under one heading, and the BS row is
            three controls wide.
          */}
          <div className="w-full min-w-0 sm:w-[15rem]">
            <label htmlFor="h-from" className="label">
              From
            </label>
            <DualDateField
              id="h-from"
              name="from"
              defaultValue={historyFrom}
              compact
              aria-label="History from"
            />
          </div>

          <div className="w-full min-w-0 sm:w-[15rem]">
            <label htmlFor="h-to" className="label">
              To
            </label>
            <DualDateField
              id="h-to"
              name="to"
              defaultValue={historyTo}
              compact
              aria-label="History to"
            />
          </div>

          <div className="w-full min-w-0 sm:w-[11rem]">
            <label htmlFor="h-reason" className="label">
              Reason
            </label>
            <select
              id="h-reason"
              name="reason"
              defaultValue={historyReason ?? ""}
              className="input"
            >
              <option value="">Any reason</option>
              {RETURN_REASONS.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          {/* The one field with no natural width: it takes what is left. */}
          <div className="min-w-[14rem] flex-1">
            <label htmlFor="h-search" className="label">
              Search
            </label>
            <input
              id="h-search"
              name="hq"
              type="search"
              defaultValue={historySearch}
              placeholder="Bill no, customer, phone or cashier"
              className="input"
            />
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary">
              Filter
            </button>
            {historyReason || historySearch || params.from || params.to ? (
              <Link
                href={q ? `/sales/returns?q=${encodeURIComponent(q)}` : "/sales/returns"}
                className="btn-secondary"
              >
                Clear
              </Link>
            ) : null}
          </div>
        </form>

        {history.length === 0 ? (
          <EmptyState
            title={
              historyReason || historySearch
                ? "No returns match these filters"
                : "No returns in this range"
            }
            description={
              historyReason || historySearch
                ? "Try widening the dates, or clearing the reason and search."
                : "Find an invoice above to take medicine back."
            }
          />
        ) : (
          /*
            The log sits in a frame of its own, inset to the same margin as the
            filter tray above it. Full-bleed, its first row ran straight into
            the card edge and the two blocks read as one undivided sheet.
          */
          <div className="mx-4 mb-4 overflow-hidden rounded-xl border border-slate-200">
            <TableWrap minWidth="54rem" pinFirst pinLast>
              <thead className="border-b border-slate-200 bg-slate-50">
                {/*
                  Nine columns in a frame that is already inset from the card,
                  so it runs out of room earlier than a full-bleed table. The
                  bill leads on a phone, with when and who folded under it,
                  and the refund and its receipt keep their place.
                */}
                <tr>
                  <th className="th">Returned</th>
                  <th className="th">Bill no</th>
                  <th className="th">Customer</th>
                  <th className="th">Reason</th>
                  <th className="th">Refunded as</th>
                  <th className="th">By</th>
                  <th className="th text-right">Units</th>
                  <th className="th text-right">Refund</th>
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((row) => (
                  <tr
                    key={`${String(row._id)}:${row.returnIndex}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="td whitespace-nowrap text-slate-600">
                      {formatDateTime(row.returnedAt)}
                    </td>
                    <td className="td">
                      <Link
                        href={`/sales/${String(row._id)}`}
                        className="font-mono font-medium text-brand-700 hover:underline"
                      >
                        {displayBillNo(row.billNo)}
                      </Link>
                    </td>
                    <td className="td">
                      {row.customerName || "Walk-in"}
                    </td>
                    <td className="td max-w-[16rem] text-slate-600">
                      <span className="block truncate" title={row.reason}>
                        {row.reason || "—"}
                      </span>
                      {/*
                        The physical check, as a badge rather than a column: it
                        is only interesting when it is missing, which is exactly
                        what an auditor pulling this log is looking for.
                      */}
                      {!row.conditionConfirmed ? (
                        <Badge tone="amber" className="mt-1">
                          Condition not confirmed
                        </Badge>
                      ) : null}
                    </td>
                    <td className="td">
                      {isRefundMethod(row.refundMethod) ? (
                        <Badge tone={row.refundMethod === "adjust" ? "slate" : "green"}>
                          {REFUND_METHOD_LABELS[row.refundMethod]}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">Not recorded</span>
                      )}
                    </td>
                    <td className="td text-slate-500">
                      {row.returnedByName || "—"}
                    </td>
                    <td className="td tnum text-right">
                      {row.units}
                    </td>
                    <td className="td tnum text-right font-medium">
                      {money(row.totalAmount)}
                    </td>
                    <td className="td col-actions">
                      <ActionBar>
                        <ActionIcon
                          label="View receipt"
                          icon="receipt"
                          tone="primary"
                          href={`/returns/${String(row._id)}/${row.returnIndex}`}
                        />
                      </ActionBar>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}
      </Card>
    </>
  );
}

/** One export format, as a small labelled button. */
function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-brand-700"
    >
      <svg
        className="h-3.5 w-3.5 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.9}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
        />
      </svg>
      {label}
    </a>
  );
}
