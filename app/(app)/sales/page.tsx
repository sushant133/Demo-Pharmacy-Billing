import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { pharmacyFilter } from "@/lib/tenant";
import {
  addDays,
  dateRangeFromStrings,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { formatDateTime, integer, money } from "@/lib/format";
import { Sale, PAYMENT_MODES, PAYMENT_MODE_LABELS, type PaymentMode } from "@/models/Sale";
import { can } from "@/lib/roles";
import {
  SALE_STATUSES,
  SALE_STATUS_LABELS,
  isSaleStatus,
  saleStatusFilter,
  saleStatusFor,
  type SaleStatus,
} from "@/lib/sale-status";
import { adIsoToBsIso } from "@/lib/bs-date";
import { DualDateField } from "@/components/DualDateField";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { SaleRow } from "@/components/sales/SaleRow";
import {
  Badge,
  Card,
  EmptyState,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Sales" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Columns the table may be ordered by, and the field each one means.
 *
 * A whitelist rather than a passthrough: `sort` arrives from the query string,
 * and handing an arbitrary string to Mongo's sort would let a crafted URL
 * order by anything in the document, including fields this screen deliberately
 * does not show.
 *
 * Items is absent on purpose. Unit count is summed from the line array rather
 * than stored, so ordering by it needs an aggregation pipeline the rest of
 * this query does not use - and a header that sorts wrongly is worse than one
 * that does not sort.
 */
const SORT_FIELDS = {
  bill: "billSeq",
  date: "createdAt",
  customer: "customerName",
  total: "totalAmount",
} as const;

type SortKey = keyof typeof SORT_FIELDS;

function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && value in SORT_FIELDS;
}

/**
 * Sales history.
 *
 * A server component with a plain GET form for filtering: no client JS, the
 * URL is the state, and a filtered view is a shareable, bookmarkable link.
 */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    paymentMode?: string;
    status?: string;
    q?: string;
    page?: string;
    branch?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;
  const status = isSaleStatus(params.status) ? params.status : null;

  // Newest first is what a sales screen is for; everything else is opt-in.
  const sort: SortKey = isSortKey(params.sort) ? params.sort : "date";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";

  const page = Math.max(1, Number(params.page) || 1);
  const today = toDateInputValue();
  // Default to today, which is what staff want nine times out of ten.
  const askedFrom = params.from ?? today;
  const askedTo = params.to ?? today;
  // A range typed backwards - "from the 15th to the 13th" - would silently
  // match nothing and read as "there were no sales", which is the one wrong
  // answer a sales screen must never give. Read it as the range they meant.
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const { sales, total, summary } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const filter: Record<string, unknown> = {
      ...pharmacyFilter(user),
      ...branchFilter(scope),
    };
    const { start, end } = dateRangeFromStrings(from, to);
    if (start || end) {
      const range: Record<string, Date> = {};
      if (start) range.$gte = start;
      if (end) range.$lt = end;
      filter.createdAt = range;
    }

    if (params.paymentMode && PAYMENT_MODES.includes(params.paymentMode as PaymentMode)) {
      filter.paymentMode = params.paymentMode;
    }

    // Status and search both need an `$or` of their own - "paid, or written
    // before the payment ledger" and "bill no, customer or medicine" - so they
    // are combined under `$and` rather than assigned onto the same key, where
    // whichever ran second would silently win.
    const clauses: Record<string, unknown>[] = [];

    // Paid / Pending / Refunded / Cancelled, from the same rule that draws the
    // badges, so the dropdown cannot return a row the badge disagrees with.
    if (status) clauses.push(saleStatusFilter(status));

    if (params.q?.trim()) {
      const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(safe, "i");
      clauses.push({
        $or: [
          { billNo: pattern },
          { customerName: pattern },
          { customerPhone: pattern },
          { "items.medicineName": pattern },
        ],
      });
    }

    if (clauses.length > 0) filter.$and = clauses;

    const [sales, total, summaryAgg] = await Promise.all([
      Sale.find(filter)
        /*
          `_id` as a tiebreaker, always. Two bills raised in the same second -
          routine at a busy counter - would otherwise come back in whatever
          order the storage engine felt like, and an unstable sort means page 2
          can repeat a row from page 1 and drop another entirely.
        */
        .sort({ [SORT_FIELDS[sort]]: dir === "asc" ? 1 : -1, _id: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Sale.countDocuments(filter),
      Sale.aggregate([
        { $match: { ...filter, voidedAt: null } },
        {
          $group: {
            _id: null,
            gross: {
              $sum: {
                $subtract: [
                  "$totalAmount",
                  { $ifNull: ["$returnedTotal", 0] },
                ],
              },
            },
            vat: {
              $sum: {
                $subtract: [
                  "$vatAmount",
                  { $ifNull: ["$returnedVat", 0] },
                ],
              },
            },
            discount: {
              $sum: {
                $subtract: [
                  "$discount",
                  { $ifNull: ["$returnedDiscount", 0] },
                ],
              },
            },
            units: {
              $sum: {
                $subtract: [
                  { $sum: "$items.quantity" },
                  { $ifNull: ["$returnedUnits", 0] },
                ],
              },
            },
            // Money still to collect in this range. Counted only for bills
            // carrying an explicit unsettled status: a bill written before the
            // payment ledger has no `amountReceived`, and treating that
            // missing field as zero would report the whole sales history as
            // debt.
            outstanding: {
              $sum: {
                $cond: [
                  { $in: ["$paymentStatus", ["partial", "unpaid"]] },
                  {
                    $max: [
                      0,
                      {
                        $subtract: [
                          {
                            $subtract: [
                              "$totalAmount",
                              { $ifNull: ["$returnedTotal", 0] },
                            ],
                          },
                          { $ifNull: ["$amountReceived", 0] },
                        ],
                      },
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    return {
      sales,
      total,
      summary: (summaryAgg[0] ?? {}) as {
        gross?: number;
        vat?: number;
        discount?: number;
        units?: number;
        outstanding?: number;
      },
    };
  });

  // Preserve every filter except `page` when paginating.
  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (params.paymentMode) baseQuery.set("paymentMode", params.paymentMode);
  if (status) baseQuery.set("status", status);
  if (params.q) baseQuery.set("q", params.q);
  if (sort !== "date") baseQuery.set("sort", sort);
  if (dir !== "desc") baseQuery.set("dir", dir);

  /**
   * Where a column heading points.
   *
   * Clicking the column already sorted flips its direction; clicking a new one
   * starts it in the sensible direction for that kind of value - newest and
   * largest first for dates and money, A-Z for a name. Paging is dropped,
   * because page 4 of the old order is meaningless in the new one.
   */
  const sortHref = (key: SortKey) => {
    const query = new URLSearchParams(baseQuery);
    const nextDir =
      sort === key
        ? dir === "asc"
          ? "desc"
          : "asc"
        : key === "customer"
          ? "asc"
          : "desc";

    query.set("sort", key);
    query.set("dir", nextDir);
    query.delete("page");
    return `/sales?${query.toString()}`;
  };

  /** A status chip's link: same range and search, different status. */
  const statusHref = (next: string | null) => {
    const query = new URLSearchParams(baseQuery);
    if (next) query.set("status", next);
    else query.delete("status");
    query.delete("page");
    return `/sales?${query.toString()}`;
  };

  /*
    Export runs off the sales register report, which exposes VAT and margin -
    so it needs the financial permission as well as the export one. A cashier
    sees no button rather than a button that returns 403.
  */
  const canExport =
    can(user.role, "report:export") && can(user.role, "report:financial");

  const exportHref = (format: "xlsx" | "pdf" | "csv") =>
    `/api/export?report=sales-register&format=${format}&from=${encodeURIComponent(
      from,
    )}&to=${encodeURIComponent(to)}`;

  // Whether anything has been narrowed beyond the default "today", which is
  // what decides if "Reset filters" has anything to reset.
  const filtered = Boolean(
    status || params.paymentMode || params.q?.trim() || from !== today || to !== today,
  );

  const outstanding = summary.outstanding ?? 0;
  // The Outstanding tile keeps the current date range and drops to Pending.
  const pendingQuery = new URLSearchParams(baseQuery);
  pendingQuery.set("status", "pending");

  /**
   * The ranges a counter actually asks for, as links.
   *
   * Nine sales screens in ten are opened to answer "how did today go?" or
   * "what did this week come to?", and typing two dates to find out is three
   * interactions too many. Every other filter is carried across, so switching
   * range never silently drops the status or search someone just set.
   */
  // Both are derived from `today`, which is already the date in the business
  // timezone. Asking the server's own clock what day of the week it is would
  // be a day out for the hours when Kathmandu and the VPS disagree on the
  // date - which is exactly the late-evening window a shop is cashing up in.
  const todayDate = parseLocalDate(today);
  const weekStart = todayDate
    ? toDateInputValue(addDays(todayDate, -((todayDate.getUTCDay() + 6) % 7)))
    : today;
  const monthStart = `${today.slice(0, 7)}-01`;

  const ranges = [
    { key: "today", label: "Today", from: today, to: today },
    { key: "week", label: "This Week", from: weekStart, to: today },
    { key: "month", label: "This Month", from: monthStart, to: today },
  ] as const;

  const rangeHref = (next: { from: string; to: string }) => {
    const query = new URLSearchParams(baseQuery);
    query.set("from", next.from);
    query.set("to", next.to);
    return `/sales?${query.toString()}`;
  };

  const activeRange = ranges.find(
    (range) => range.from === from && range.to === to,
  );

  return (
    <>
      {/*
        This screen's own header, rather than the shared `PageHeader`.

        The marked-up title tile only suits a screen that is somebody's main
        workplace, and putting it in the shared component would have redrawn
        the top of all sixty-odd screens to solve a problem on one of them.
      */}
      <header className="mb-4 flex flex-col gap-3 sm:gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm shadow-brand-900/20 sm:h-14 sm:w-14"
          >
            <svg
              className="h-6 w-6 sm:h-7 sm:w-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 7h18l-1.4 9.2A2 2 0 0117.62 18H8.38a2 2 0 01-1.98-1.8L5 7m0 0L4 4H2m6 14a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm9 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl lg:text-3xl">
              Sales
            </h1>
            {/*
              The range, in both calendars, phrased exactly as the filter bar
              below states it. The From/To fields carry an AD box and a BS
              picker, so a heading that named only the AD date was describing
              half of what the user had just set - and the Nepali date is the
              one most of this shop's paperwork is filed under.
            */}
            <p className="mt-0.5 text-xs text-pretty text-slate-500 sm:text-sm">
              {from === to ? "Bills for " : "Bills from "}
              <span className="font-medium text-slate-700">{dualDate(from)}</span>
              {from === to ? null : (
                <>
                  {" to "}
                  <span className="font-medium text-slate-700">{dualDate(to)}</span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:shrink-0">
          {/*
            A <details> menu rather than a React dropdown: it opens, closes on
            Escape, and is keyboard-reachable with no JavaScript and no state
            in a screen that otherwise has neither. The three formats are plain
            links to the export route, so each is also a right-click-saveable
            URL.
          */}
          {canExport ? (
            <details className="group relative">
              <summary className="btn-secondary cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <svg
                  className="h-4 w-4 text-slate-400"
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
                Export
                <svg
                  className="h-3.5 w-3.5 text-slate-400 transition-transform group-open:rotate-180"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </summary>

              <div className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5">
                <p className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                  Sales register for{" "}
                  <span className="font-medium text-slate-700">
                    {from === to ? from : `${from} – ${to}`}
                  </span>
                </p>
                <ExportLink href={exportHref("xlsx")} label="Excel" hint=".xlsx" />
                <ExportLink href={exportHref("pdf")} label="PDF" hint=".pdf" />
                <ExportLink href={exportHref("csv")} label="CSV" hint=".csv" />
              </div>
            </details>
          ) : null}

          <Link href="/sales/returns" className="btn-secondary">
            <svg
              className="h-4 w-4 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"
              />
            </svg>
            Record a return
          </Link>

          {/*
            The one thing anyone opens this screen to do next. Gated on the
            permission: a role that cannot bill is not offered a till.
          */}
          {can(user.role, "sale:create") ? (
            <Link href="/billing" className="btn-primary">
              <svg
                className="h-4.5 w-4.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.9}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" d="M12 8.5v7M8.5 12h7" />
              </svg>
              New Sale
            </Link>
          ) : null}
        </div>
      </header>

      {/*
        Filters - a plain GET form, so the URL carries the state.

        One flat row of controls, bottom-aligned, with no rules dividing it
        into groups. The bar used to be three bordered columns stacked two deep,
        which drew a box around "when" and a box around "what" - a distinction
        nobody reading a sales register is making. Wrapping does the grouping
        instead: the fields fall onto a second line in the order they are set.

        The From/To cells stand taller than the rest, because each carries both
        an AD box and a BS picker. Everything else hangs off the bottom edge of
        the row so the controls still share one baseline.
      */}
      <Card className="mb-4 p-3.5 sm:p-4">
        <form method="get" className="flex flex-wrap items-end gap-x-3 gap-y-3.5">
          <div className="w-full min-w-0 sm:w-[15rem]">
            <FilterLabel>From</FilterLabel>
            <DualDateField
              id="from"
              name="from"
              defaultValue={from}
              compact
              aria-label="From"
            />
          </div>

          <div className="w-full min-w-0 sm:w-[15rem]">
            <FilterLabel>To</FilterLabel>
            <DualDateField
              id="to"
              name="to"
              defaultValue={to}
              compact
              aria-label="To"
            />
          </div>

          {/*
            The ranges people actually ask for. Links rather than a control,
            so the URL stays the single source of truth for what is shown -
            and so a chosen range is bookmarkable like every other filter.

            No calendar glyph on each one: three identical icons in a row said
            only "these are dates", which the two date boxes beside them have
            already said.
          */}
          <div className="flex flex-wrap items-center gap-2">
            {ranges.map((range) => {
              const active = activeRange?.key === range.key;
              return (
                <Link
                  key={range.key}
                  href={rangeHref(range)}
                  aria-current={active ? "true" : undefined}
                  className={cx(
                    "inline-flex items-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "border-brand-500 bg-white text-brand-700"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {range.label}
                </Link>
              );
            })}

            {/*
              Not a button: the From and To boxes are right there, so there
              is nothing for a "Custom" control to open. It is a state
              marker, shown only while the range really is a custom one.
            */}
            {!activeRange ? (
              <span className="inline-flex items-center rounded-lg border border-brand-500 bg-white px-3 py-2 text-sm font-medium text-brand-700">
                Custom
              </span>
            ) : null}
          </div>

          <div className="w-full min-w-0 sm:w-[9.5rem]">
            <FilterLabel htmlFor="status">Status</FilterLabel>
            <select
              id="status"
              name="status"
              defaultValue={status ?? ""}
              className="input"
            >
              <option value="">All statuses</option>
              {SALE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {SALE_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="w-full min-w-0 sm:w-[9.5rem]">
            <FilterLabel htmlFor="paymentMode">Payment</FilterLabel>
            <select
              id="paymentMode"
              name="paymentMode"
              defaultValue={params.paymentMode ?? ""}
              className="input"
            >
              <option value="">All modes</option>
              {PAYMENT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {PAYMENT_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>

          {/* The one field with no natural width: it takes what is left. */}
          <div className="min-w-[14rem] flex-1">
            <FilterLabel htmlFor="q">Search</FilterLabel>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={params.q ?? ""}
              placeholder="Bill no, customer, phone or medicine"
              className="input"
            />
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.9}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 5h16l-6.2 7.3v5.5l-3.6 2v-7.5z"
                />
              </svg>
              Apply
            </button>
            {/*
              Kept, though the mock-up dropped it: once four filters can be
              set at once, getting back to the default view by hand is a
              chore, and clearing them is the second most common thing
              anyone does here.
            */}
            {filtered ? (
              <Link href="/sales" className="btn-secondary">
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {/*
        Outstanding only earns a tile when there is something outstanding, so a
        shop that never sells on credit sees the same four figures it always
        has. Clicking it filters to exactly the bills behind the number.
      */}
      <div
        className={cx(
          "mb-4 grid grid-cols-2 gap-3",
          outstanding > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        )}
      >
        <StatCard label="Bills" value={integer(total)} tone="brand" />
        <StatCard label="Gross sales" value={money(summary.gross ?? 0)} />
        <StatCard label="VAT collected" value={money(summary.vat ?? 0)} />
        <StatCard label="Units sold" value={integer(summary.units ?? 0)} />
        {outstanding > 0 ? (
          <StatCard
            label="Outstanding"
            value={money(outstanding)}
            hint="Still to collect"
            tone="warning"
            href={`/sales?${pendingQuery.toString()}`}
          />
        ) : null}
      </div>

      {/*
        Status chips.
        --------------
        The same four states the dropdown offers and the badges draw, as
        one-click filters - switching between "everything" and "what is still
        owed" is the commonest thing anyone does here, and it should not cost
        a dropdown and an Apply.

        Drawn from SALE_STATUSES rather than a hand-written list, so a chip
        cannot name a state the filter does not have. That is also why there is
        no "Credit" chip: this system calls an unsettled bill *Pending*, the
        badge in the row says Pending, and a chip promising something else
        would be the one label on the screen that lies.
      */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <StatusChip href={statusHref(null)} active={!status} label="All" />
        {SALE_STATUSES.map((value) => (
          <StatusChip
            key={value}
            href={statusHref(value)}
            active={status === value}
            label={SALE_STATUS_LABELS[value]}
            tone={value}
          />
        ))}
      </div>

      <Card className="overflow-hidden">
        {sales.length === 0 ? (
          <EmptyState
            title={filtered ? "No bills match these filters" : "No bills yet today"}
            description={
              filtered
                ? "Try widening the date range, or clearing the status and payment filters."
                : "Bills appear here as soon as the counter raises one."
            }
            action={
              filtered ? (
                <Link href="/sales" className="btn-secondary">
                  Reset filters
                </Link>
              ) : can(user.role, "sale:create") ? (
                <Link href="/billing" className="btn-primary">
                  New Sale
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap minWidth="58rem" pinFirst pinLast>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <SortableTh
                    label="Bill no"
                    href={sortHref("bill")}
                    active={sort === "bill"}
                    dir={dir}
                  />
                  <SortableTh
                    label="Date & time"
                    href={sortHref("date")}
                    active={sort === "date"}
                    dir={dir}
                  />
                  <SortableTh
                    label="Customer"
                    href={sortHref("customer")}
                    active={sort === "customer"}
                    dir={dir}
                  />
                  {/*
                    Narrow screens keep the columns that answer "which bill,
                    whose, what state, how much" and drop the rest. The table
                    still scrolls, so nothing is unreachable - this only
                    decides what is worth showing without scrolling. Phone is
                    among the first to go: it is the column you look up on
                    purpose, not one you scan.
                  */}
                  <th className="th">Phone</th>
                  <th className="th text-right">Items</th>
                  <th className="th">Payment</th>
                  <th className="th">Status</th>
                  <th className="th">Cashier</th>
                  <SortableTh
                    label="Total"
                    href={sortHref("total")}
                    active={sort === "total"}
                    dir={dir}
                    align="right"
                  />
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sales.map((sale) => {
                  const units = sale.items.reduce(
                    (sum, item) => sum + item.quantity,
                    0,
                  );
                  const state = saleStatusFor(sale);
                  const id = String(sale._id);

                  /*
                    What was on the bill, for the hover tooltip on the item
                    count. A native `title` rather than a styled popover: it
                    survives without JavaScript, it is announced by screen
                    readers, and a cashier wanting to know what a bill was for
                    without opening it is exactly the glance it was designed
                    for. Capped, because a twenty-line bill in a tooltip is a
                    wall nobody reads.
                  */
                  const names = sale.items.map(
                    (item) => `${item.quantity} x ${item.medicineName}`,
                  );
                  const itemTooltip =
                    names.length > 8
                      ? `${names.slice(0, 8).join("\n")}\n+ ${names.length - 8} more`
                      : names.join("\n");

                  return (
                    <SaleRow key={id} href={`/sales/${id}`}>
                      <td className="td">
                        <Link
                          href={`/sales/${String(sale._id)}`}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {sale.billNo}
                        </Link>
                      </td>
                      <td className="td tnum whitespace-nowrap text-slate-600">
                        {formatDateTime(sale.createdAt as unknown as Date)}
                      </td>
                      <td className="td">
                        <span className="block max-w-[12rem] truncate font-medium text-slate-900">
                          {sale.customerName || (
                            <span className="font-normal text-slate-400">
                              Walk-in
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="td tnum whitespace-nowrap text-slate-600">
                        {sale.customerPhone ? (
                          // tel: so a tablet at the counter can call a customer
                          // about an unpaid bill straight from the register.
                          <a
                            href={`tel:${sale.customerPhone}`}
                            className="hover:text-brand-700 hover:underline"
                          >
                            {sale.customerPhone}
                          </a>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td
                        className="td tnum text-right"
                        title={itemTooltip}
                      >
                        <span className="cursor-help border-b border-dotted border-slate-300">
                          {units}
                        </span>
                      </td>
                      <td className="td">
                        <Badge tone="slate">
                          {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ??
                            sale.paymentMode}
                        </Badge>
                      </td>
                      <td className="td">
                        <Badge tone={state.tone}>{state.label}</Badge>
                        {/*
                          A pending bill is only useful if it says how much is
                          pending - that is the number someone is about to ask
                          the customer for.
                        */}
                        {state.remaining > 0 ? (
                          <span className="tnum mt-0.5 block text-[11px] font-medium text-amber-700">
                            {money(state.remaining)} due
                          </span>
                        ) : null}
                      </td>
                      <td className="td text-slate-600">
                        {sale.soldByName || "—"}
                      </td>
                      <td className="td tnum text-right font-semibold text-slate-900">
                        {money(sale.totalAmount)}
                      </td>
                      <td className="td col-actions">
                        <ActionBar>
                          <ActionIcon
                            label="View details"
                            icon="view"
                            tone="primary"
                            href={`/sales/${String(sale._id)}`}
                          />
                          <ActionIcon
                            label="Print"
                            icon="print"
                            href={`/bills/${String(sale._id)}`}
                          />
                        </ActionBar>
                      </td>
                    </SaleRow>
                  );
                })}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
              total={total}
              baseHref={`/sales?${baseQuery.toString()}`}
            />
          </>
        )}
      </Card>
    </>
  );
}

/*
  Field icons.
  ------------
  Drawn from the same 24x24 stroked set the sidebar and the rest of the app
  use, so the filter bar reads as part of the application rather than as a
  pasted-in widget.
*/
/**
 * A date in both calendars, e.g. "2026-09-16 · 2083-05-31".
 *
 * The BS conversion table covers a finite span of years, so a date outside it
 * returns null rather than throwing. An AD-only heading is still a correct
 * heading; a crashed sales screen is not.
 */
function dualDate(iso: string): string {
  if (!iso) return "—";
  const bs = adIsoToBsIso(iso);
  return bs ? `${iso} · ${bs} BS` : iso;
}

/** One status filter chip. */
function StatusChip({
  href,
  label,
  active,
  tone,
}: {
  href: string;
  label: string;
  active: boolean;
  /** Colours the dot, so a chip matches the badge it filters to. */
  tone?: SaleStatus;
}) {
  const dot: Record<SaleStatus, string> = {
    paid: "bg-emerald-500",
    pending: "bg-amber-500",
    refunded: "bg-slate-400",
    cancelled: "bg-rose-500",
  };

  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-brand-300 bg-brand-50 text-brand-700 shadow-sm"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
      )}
    >
      {tone ? (
        <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", dot[tone])} />
      ) : null}
      {label}
    </Link>
  );
}

/**
 * A column heading that sorts.
 *
 * `aria-sort` on the cell is what tells a screen reader the table is ordered
 * and which way - the arrow alone says it only to people who can see it.
 */
function SortableTh({
  label,
  href,
  active,
  dir,
  align = "left",
}: {
  label: string;
  href: string;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
}) {
  return (
    <th
      className={cx("th", align === "right" && "text-right")}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={href}
        scroll={false}
        className={cx(
          "group inline-flex items-center gap-1 transition-colors hover:text-slate-900",
          align === "right" && "flex-row-reverse",
          active && "text-slate-900",
        )}
      >
        {label}
        <svg
          className={cx(
            "h-3 w-3 shrink-0 transition",
            active
              ? "text-brand-600"
              : "text-slate-300 opacity-0 group-hover:opacity-100",
            active && dir === "asc" && "rotate-180",
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-6-6m6 6l6-6" />
        </svg>
      </Link>
    </th>
  );
}

/** One row of the export menu. */
function ExportLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <a
      href={href}
      className="flex items-center justify-between px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50 hover:text-brand-700"
    >
      <span className="flex items-center gap-2">
        <svg
          className="h-4 w-4 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 21h10a2 2 0 002-2V8.4L13.6 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
        {label}
      </span>
      <span className="font-mono text-[11px] text-slate-400">{hint}</span>
    </a>
  );
}

/**
 * A filter field's label: plain words, no glyph.
 *
 * The icon each label used to carry is gone. A calendar beside "From", a card
 * beside "Payment" and a funnel beside "Status" were four different glyphs in
 * one short row, none of which told anyone something the word next to it had
 * not already said - and on a bar this dense they read as clutter.
 *
 * `htmlFor` is omitted for the date fields on purpose - `DualDateField`
 * renders several inputs under one heading, so there is no single control for
 * a label to point at, and a label pointing at the wrong one is worse than a
 * plain heading.
 */
function FilterLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: ReactNode;
}) {
  const className = "mb-1.5 block text-xs font-medium text-slate-600";

  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ) : (
    <p className={className}>{children}</p>
  );
}
