import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs } from "@/lib/bs-date";
import { withDbRead } from "@/lib/db";
import {
  addDays,
  dateRangeFromStrings,
  localParts,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { formatDate, formatTime, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  SALE_STATUSES,
  SALE_STATUS_LABELS,
  isSaleStatus,
  saleStatusFilter,
  saleStatusFor,
  type SaleStatus,
} from "@/lib/sale-status";
import {
  Sale,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/models/Sale";
import { DualDateField } from "@/components/DualDateField";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { SaleRow } from "@/components/sales/SaleRow";
import { RecordPaymentDialog } from "@/components/sales/RecordPaymentDialog";
import {
  Badge,
  Card,
  EmptyState,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";
import { NotWiredYet } from "@/components/ModuleScaffold";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Invoices: the bills raised for a named customer.
 *
 * A counter sale and an invoice are the same document in this system - a Sale
 * with a printable bill behind it. What makes one an invoice is that it is
 * billed *to* somebody: a named customer, usually one with a PAN, who expects
 * a document they can put in their own books. Sales lists everything; this
 * lists the ones somebody is going to ask for a copy of.
 *
 * Which is why this screen is not a second sales history with a narrower
 * filter. Three questions get asked of an invoice and of nothing else:
 *
 *   - "Can I have a copy of that?"  - hence the PDF beside every row.
 *   - "Has this one been paid?"     - hence the status, the balance, and the
 *                                     receivables tile above the list.
 *   - "They are paying it now."     - hence Collect, which was the half of the
 *                                     payment ledger no screen ever called.
 *
 * A server component with a plain GET form for filtering: no client JS beyond
 * the payment panel, the URL is the state, and a filtered view is a shareable
 * link. Unlike /sales it does not default to today - an invoice is looked up
 * months after it was raised, and a screen that opens on an empty list because
 * nobody was billed by name this morning is a screen that looks broken.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    status?: string;
    paymentMode?: string;
    q?: string;
    page?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const status = isSaleStatus(params.status) ? params.status : null;
  const mode = PAYMENT_MODES.includes(params.paymentMode as PaymentMode)
    ? (params.paymentMode as PaymentMode)
    : null;
  const search = (params.q ?? "").trim();

  // A range typed backwards - "from the 15th to the 13th" - would silently
  // match nothing and read as "there are no invoices", which is the one wrong
  // answer this screen must never give. Read it as the range they meant.
  const askedFrom = (params.from ?? "").trim();
  const askedTo = (params.to ?? "").trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const { rows, total, summary } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);

    // Named customer only. An anonymous walk-in gets a receipt, not an invoice.
    const filter: Record<string, unknown> = {
      ...branchFilter(scope),
      customerName: { $nin: [null, ""] },
    };

    const { start, end } = dateRangeFromStrings(from, to);
    if (start || end) {
      const range: Record<string, Date> = {};
      if (start) range.$gte = start;
      if (end) range.$lt = end;
      filter.createdAt = range;
    }

    if (mode) filter.paymentMode = mode;

    // Status and search both need an `$or` of their own - "paid, or written
    // before the payment ledger" and "bill no, customer, phone or PAN" - so
    // they are combined under `$and` rather than assigned onto the same key,
    // where whichever ran second would silently win.
    const clauses: Record<string, unknown>[] = [];

    // Drawn from the same rule that draws the badges, so the dropdown cannot
    // return a row the badge disagrees with.
    if (status) clauses.push(saleStatusFilter(status));

    if (search) {
      const pattern = new RegExp(escapeRegExp(search), "i");
      clauses.push({
        $or: [
          { billNo: pattern },
          { customerName: pattern },
          { customerPhone: pattern },
          { customerPan: pattern },
          // "Which invoice had the Pantop on it?" is a question asked at the
          // counter as often as "what was Ram Thapa's bill number?", and the
          // sales screen has always answered it. This list could not.
          { "items.medicineName": pattern },
        ],
      });
    }

    if (clauses.length > 0) filter.$and = clauses;

    const [rows, total, sums] = await Promise.all([
      Sale.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Sale.countDocuments(filter),
      Sale.aggregate<{
        _id: null;
        invoiced: number;
        collected: number;
        outstanding: number;
        unpaidCount: number;
      }>([
        // A voided invoice is owed nothing and was worth nothing, so it is
        // left out of every figure while staying in the list and the count.
        { $match: { ...filter, voidedAt: null } },
        {
          $group: {
            _id: null,
            invoiced: {
              $sum: {
                $subtract: ["$totalAmount", { $ifNull: ["$returnedTotal", 0] }],
              },
            },
            // Bills written before the payment ledger carry no `paymentStatus`
            // and a meaningless `amountReceived` of 0. Those were paid in full
            // at the till, so they count as collected at their net value -
            // believing the stored zero would report the shop's whole history
            // as debt. The same rule `saleStatusFor` applies to the badges.
            collected: {
              $sum: {
                $cond: [
                  { $in: ["$paymentStatus", ["partial", "unpaid"]] },
                  { $ifNull: ["$amountReceived", 0] },
                  {
                    $subtract: [
                      "$totalAmount",
                      { $ifNull: ["$returnedTotal", 0] },
                    ],
                  },
                ],
              },
            },
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
            unpaidCount: {
              $sum: {
                $cond: [
                  { $in: ["$paymentStatus", ["partial", "unpaid"]] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    return { rows, total, summary: sums[0] ?? null };
  });

  const canSeeMoney = can(user.role, "report:financial");
  const canCollect = can(user.role, "payment:write");
  const invoiced = summary?.invoiced ?? 0;
  const collected = summary?.collected ?? 0;
  const outstanding = summary?.outstanding ?? 0;
  const unpaidCount = summary?.unpaidCount ?? 0;

  // Preserve every filter except `page` when paginating, and every filter
  // except the dates when a quick range is picked.
  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (status) baseQuery.set("status", status);
  if (mode) baseQuery.set("paymentMode", mode);
  if (search) baseQuery.set("q", search);

  const filtered = Boolean(from || to || status || mode || search);

  // The Outstanding tile keeps the current filters and drops to Pending.
  const pendingQuery = new URLSearchParams(baseQuery);
  pendingQuery.set("status", "pending");

  /** A status chip's link: same range and search, different status. */
  const statusHref = (next: string | null) => {
    const query = new URLSearchParams(baseQuery);
    if (next) query.set("status", next);
    else query.delete("status");
    query.delete("page");
    return `/invoices?${query.toString()}`;
  };

  const canExport =
    can(user.role, "report:export") && can(user.role, "report:financial");

  /*
    The range the export covers.

    This screen's default view has no date filter at all - it lists every
    invoice ever raised - and the export route needs a real start and end, so
    "everything" is not a range it can be asked for. Rather than silently
    exporting today and calling it the register, an unfiltered screen exports
    the last twelve months, and the menu prints the dates it is about to use.
    What downloads is then never a surprise.
  */
  const exportTo = to || toDateInputValue();
  const exportFrom =
    from ||
    toDateInputValue(addDays(parseLocalDate(exportTo) ?? new Date(), -365));

  const exportHref = (format: "xlsx" | "pdf" | "csv") =>
    `/api/export?report=sales-register&format=${format}&from=${encodeURIComponent(
      exportFrom,
    )}&to=${encodeURIComponent(exportTo)}`;

  /*
    The ranges somebody actually asks for, as links.

    Derived from `today`, which is already the date in the business timezone.
    Asking the server's own clock what month it is would be a day out for the
    hours when Kathmandu and the VPS disagree on the date - exactly the
    late-evening window a shop is cashing up in.
  */
  const today = toDateInputValue();
  const todayDate = parseLocalDate(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const quarterStart = todayDate
    ? toDateInputValue(
        new Date(
          Date.UTC(
            todayDate.getUTCFullYear(),
            todayDate.getUTCMonth() - 2,
            1,
            12,
          ),
        ),
      )
    : monthStart;

  const ranges = [
    { key: "all", label: "All time", from: "", to: "" },
    { key: "month", label: "This month", from: monthStart, to: today },
    { key: "quarter", label: "Last 3 months", from: quarterStart, to: today },
    { key: "year", label: "This year", from: yearStart, to: today },
  ] as const;

  const rangeHref = (next: { from: string; to: string }) => {
    const query = new URLSearchParams(baseQuery);
    if (next.from) query.set("from", next.from);
    else query.delete("from");
    if (next.to) query.set("to", next.to);
    else query.delete("to");
    const encoded = query.toString();
    return encoded ? `/invoices?${encoded}` : "/invoices";
  };

  const activeRange = ranges.find(
    (range) => range.from === from && range.to === to,
  );

  return (
    <>
      {/*
        This screen's own header rather than the shared `PageHeader`, matching
        the sales screen: an invoice list is somebody's workplace for the
        twenty minutes a month they chase what is owed, and the marked-up title
        tile is what tells them at a glance which of the two lists they are on.
      */}
      <header className="mb-4 flex flex-col gap-3 sm:gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-center gap-3 sm:gap-3.5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm shadow-brand-900/20 sm:h-12 sm:w-12 sm:rounded-2xl lg:h-14 lg:w-14"
          >
            <svg
              className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 3h8a2 2 0 012 2v15.5l-3-1.75-3 1.75-3-1.75-3 1.75V5a2 2 0 012-2zm0 5h8M8 12h8M8 16h5"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl lg:text-3xl">
              Invoices
            </h1>
            {/*
              The range wraps rather than truncating. Truncated, a phone showed
              "Bills from 2026-09-01 · 2083-0…" - the range this list is
              actually showing was the one thing the subtitle could not say.
            */}
            <p className="mt-0.5 text-xs text-pretty text-slate-500 sm:text-sm">
              {rangeSentence(from, to)}
            </p>
          </div>
        </div>

        {/*
          Four controls, and on a phone they wrap onto their own line under
          the title instead of being pushed off the right edge. `shrink-0`
          without `flex-wrap` was what made this row overflow the viewport.
        */}
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:shrink-0">
          {/*
            Export, in the same <details> menu the sales register uses, so the
            two screens open the same way. It carries whatever range and
            filters are set, and each format is a plain link - right-clickable,
            and no JavaScript or component state on a screen that has neither.

            Gated on `report:financial` as well as `report:export`: the sales
            register exposes cost and margin, so a role that may not read
            those sees no button rather than one that returns 403.
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

              <div className="absolute left-0 z-20 mt-1.5 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5 sm:right-0 sm:left-auto">
                <p className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                  Sales register for{" "}
                  <span className="font-medium text-slate-700">
                    {exportFrom === exportTo
                      ? exportFrom
                      : `${exportFrom} – ${exportTo}`}
                  </span>
                </p>
                <ExportLink href={exportHref("xlsx")} label="Excel" hint=".xlsx" />
                <ExportLink href={exportHref("pdf")} label="PDF" hint=".pdf" />
                <ExportLink href={exportHref("csv")} label="CSV" hint=".csv" />
              </div>
            </details>
          ) : null}

          {/*
            The dues book, for whoever opened this screen to chase money rather
            than to reprint a copy. Gated on the permission that lets them take
            the payment when they get there.
          */}
          {canCollect ? (
            <Link href="/receivables" className="btn-secondary">
              <svg
                className="h-4 w-4 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={COIN} />
              </svg>
              Receivables
            </Link>
          ) : null}

          <Link href="/sales" className="btn-secondary">
            <svg
              className="h-4 w-4 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={LIST} />
            </svg>
            All sales
          </Link>

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
              New invoice
            </Link>
          ) : null}
        </div>
      </header>

      {/*
        Filters - a plain GET form, so the URL carries the state. Same two-row
        shape as the sales screen: the dated columns are each two rows tall on
        their own (an AD box plus a BS picker), so the presets sit beside them
        and the rest of the filters fall in underneath.
      */}
      <Card className="mb-4 p-3.5 sm:p-4">
        <form
          method="get"
          className="grid gap-x-5 gap-y-3.5 lg:grid-cols-[minmax(0,15rem)_minmax(0,15rem)_minmax(0,1fr)]"
        >
          <div className="min-w-0">
            <FilterLabel icon={CALENDAR}>From</FilterLabel>
            <DualDateField
              id="from"
              name="from"
              defaultValue={from}
              compact
              aria-label="From"
            />
          </div>

          <div className="min-w-0 lg:border-l lg:border-slate-100 lg:pl-5">
            <FilterLabel icon={CALENDAR}>To</FilterLabel>
            <DualDateField
              id="to"
              name="to"
              defaultValue={to}
              compact
              aria-label="To"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-3.5 lg:border-l lg:border-slate-100 lg:pl-5">
            <div className="flex flex-wrap items-center gap-1.5">
              {ranges.map((range) => {
                const active = activeRange?.key === range.key;
                return (
                  <Link
                    key={range.key}
                    href={rangeHref(range)}
                    aria-current={active ? "true" : undefined}
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "border-brand-300 bg-brand-50 text-brand-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                    )}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d={CALENDAR} />
                    </svg>
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
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700">
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d={CALENDAR} />
                  </svg>
                  Custom
                </span>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[9rem_9rem_minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <FilterLabel icon={FILTER} htmlFor="status">
                  Status
                </FilterLabel>
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

              <div className="min-w-0">
                <FilterLabel icon={CARD} htmlFor="paymentMode">
                  Payment
                </FilterLabel>
                <select
                  id="paymentMode"
                  name="paymentMode"
                  defaultValue={mode ?? ""}
                  className="input"
                >
                  <option value="">All modes</option>
                  {PAYMENT_MODES.map((value) => (
                    <option key={value} value={value}>
                      {PAYMENT_MODE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0 sm:col-span-2 xl:col-span-1">
                <FilterLabel icon={SEARCH} htmlFor="q">
                  Search
                </FilterLabel>
                <input
                  id="q"
                  name="q"
                  type="search"
                  defaultValue={search}
                  placeholder="Invoice no, customer, PAN or medicine"
                  className="input"
                />
              </div>

              <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-1">
                <button type="submit" className="btn-primary flex-1 xl:flex-none">
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
                {filtered ? (
                  <Link href="/invoices" className="btn-secondary">
                    Reset
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </form>
      </Card>

      {/*
        Outstanding only earns a tile when there is something outstanding, so a
        shop that never invoices on credit sees three clean figures. Clicking
        it filters to exactly the invoices behind the number.
      */}
      <div
        className={cx(
          "mb-4 grid grid-cols-2 gap-3",
          !canSeeMoney ? "lg:grid-cols-2" : outstanding > 0 ? "lg:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        <StatCard
          label="Invoices"
          value={integer(total)}
          hint={filtered ? "Matching these filters" : "All time"}
          tone="brand"
        />
        {canSeeMoney ? (
          <>
            <StatCard
              label="Invoiced"
              value={money(invoiced)}
              hint="Net of returns"
            />
            <StatCard label="Collected" value={money(collected)} />
            {outstanding > 0 ? (
              <StatCard
                label="Outstanding"
                value={money(outstanding)}
                hint={`${integer(unpaidCount)} invoice${unpaidCount === 1 ? "" : "s"} to collect`}
                tone="warning"
                href={`/invoices?${pendingQuery.toString()}`}
              />
            ) : null}
          </>
        ) : (
          <StatCard
            label="To collect"
            value={integer(unpaidCount)}
            hint="Invoices not settled in full"
            tone={unpaidCount > 0 ? "warning" : "default"}
            href={`/invoices?${pendingQuery.toString()}`}
          />
        )}
      </div>

      {/*
        Quick status filters, as one-click versions of the dropdown already in
        the filter bar - they set the same `status` key and preserve every
        other filter, so the two controls can never disagree.

        Drawn from SALE_STATUSES rather than a hand-written list. That is also
        why the chips read Paid / Pending / Refunded / Cancelled rather than
        Paid / Unpaid / Partial: this screen's badges, its dropdown and
        `saleStatusFilter` all speak the first vocabulary, and a chip labelled
        "Unpaid" returning rows badged "Pending" would be the one control on
        the page that disagrees with what it shows.
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
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No invoices match these filters" : "No invoices yet"}
            description={
              filtered
                ? "Try widening the date range, or clearing the status and payment filters."
                : "Name a customer on a bill at the till and it is filed here. A walk-in with no name gets a receipt, not an invoice."
            }
            action={
              filtered ? (
                <Link href="/invoices" className="btn-secondary">
                  Reset filters
                </Link>
              ) : can(user.role, "sale:create") ? (
                <Link href="/billing" className="btn-primary">
                  Open the till
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap minWidth="48rem" pinFirst pinLast>
              <thead>
                <tr>
                  <th className="th">Invoice</th>
                  <th className="th">Date</th>
                  <th className="th">Billed to</th>
                  {/*
                    Narrow screens keep the four columns that answer "which
                    invoice, whose, what state, how much" and drop the rest.
                    The table still scrolls, so nothing is unreachable.
                  */}
                  <th className="th text-right">Items</th>
                  <th className="th">Payment</th>
                  <th className="th">Status</th>
                  {canSeeMoney ? <th className="th text-right">Total</th> : null}
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const id = String(row._id);
                  const state = saleStatusFor(row);
                  const units = row.items.reduce(
                    (sum, item) => sum + item.quantity,
                    0,
                  );
                  const paymentLabel =
                    PAYMENT_MODE_LABELS[row.paymentMode as PaymentMode] ??
                    row.paymentMode;
                  const issuedAt = row.createdAt as unknown as Date;
                  // Legacy bills carry no payment status; those were settled at
                  // the till, which is what `saleStatusFor` already concluded.
                  const received =
                    row.paymentStatus == null
                      ? row.totalAmount
                      : (row.amountReceived ?? 0);

                  return (
                    // Whole row opens the invoice. Clicks starting on the
                    // Print, View or Record-payment controls are left alone.
                    <SaleRow key={id} href={`/sales/${id}`}>
                      <td className="td">
                        <Link
                          href={`/sales/${id}`}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {row.billNo}
                        </Link>
                      </td>

                      <td className="td whitespace-nowrap">
                        <span className="tnum block text-slate-700">
                          {formatDate(issuedAt)}
                        </span>
                        {/*
                          The Nepali date, because that is the one a customer
                          quotes back and the one their own books are kept in.
                        */}
                        <span className="tnum block text-[11px] text-slate-400">
                          {bsLabel(issuedAt) || formatTime(issuedAt)}
                        </span>
                      </td>

                      <td className="td">
                        <span className="block max-w-[14rem] truncate font-medium text-slate-900">
                          {row.customerName}
                        </span>
                        <span className="tnum block text-[11px] text-slate-400">
                          {row.customerPan
                            ? `PAN ${row.customerPan}`
                            : row.customerPhone || "No PAN on file"}
                        </span>
                      </td>

                      <td className="td tnum text-right">
                        {units}
                      </td>

                      <td className="td">
                        <Badge tone="slate">{paymentLabel}</Badge>
                      </td>

                      <td className="td">
                        <Badge tone={state.tone}>{state.label}</Badge>
                        {/*
                          A pending invoice is only useful if it says how much
                          is pending - that is the number somebody is about to
                          ask the customer for.
                        */}
                        {state.remaining > 0 ? (
                          <span className="tnum mt-0.5 block text-[11px] font-medium text-amber-700">
                            {money(state.remaining)} due
                          </span>
                        ) : null}
                      </td>

                      {canSeeMoney ? (
                        <td className="td tnum text-right font-semibold text-slate-900">
                          {money(row.totalAmount)}
                        </td>
                      ) : null}

                      <td className="td col-actions">
                        <ActionBar>
                          {canCollect && state.remaining > 0 ? (
                            <RecordPaymentDialog
                              saleId={id}
                              billNo={row.billNo}
                              customerName={row.customerName}
                              outstanding={state.remaining}
                              total={row.totalAmount}
                              received={received}
                              variant="icon"
                              label="Collect payment"
                            />
                          ) : null}

                          {/*
                            A plain anchor, not a Link: this is a file download
                            from the API, and routing it through the client
                            router would only navigate away from the list.
                            Read-only, so fetching it twice does not turn the
                            original into "Copy of Original - 1".
                          */}
                          <ActionIcon
                            label="Download PDF"
                            icon="pdf"
                            href={`/api/sales/${id}/invoice`}
                            external
                          />

                          <ActionIcon
                            label="Print"
                            icon="print"
                            href={`/bills/${id}`}
                          />

                          <ActionIcon
                            label="View details"
                            icon="view"
                            tone="primary"
                            href={`/sales/${id}`}
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
              baseHref={
                baseQuery.toString()
                  ? `/invoices?${baseQuery.toString()}`
                  : "/invoices"
              }
            />
          </>
        )}
      </Card>

      <div className="mt-4 mb-4">
        <NotWiredYet
          title="An invoice still cannot be raised ahead of the goods"
          description="Every invoice here is a bill raised at the till, issued and payable the moment it prints. Billing before dispensing - a proforma, or a monthly account for a clinic - needs its own numbering and a due date, and neither exists yet."
          covers={[
            "Proforma and advance invoices",
            "Payment terms and due dates",
            "Statement of account per customer",
            "Emailing a copy to the customer",
          ]}
          insteadUse={{ href: "/sales", label: "Open sales" }}
        />
      </div>
    </>
  );
}

/** How the header describes the range currently in force. */
function rangeSentence(from: string, to: string): string {
  if (!from && !to) return "Every bill raised in a customer's name.";
  if (from && to) {
    return from === to
      ? `Invoices issued on ${from}`
      : `Invoices issued between ${from} and ${to}`;
  }
  return from ? `Invoices issued since ${from}` : `Invoices issued up to ${to}`;
}

/**
 * The Nepali date for one invoice, or an empty string.
 *
 * The BS conversion table covers a finite span of years, so a date outside it
 * throws. An AD-only row is still a perfectly readable row; a crashed list is
 * not, so a failure here falls back to the time of day instead.
 */
function bsLabel(value: Date | string | null | undefined): string {
  if (!value) return "";
  try {
    const local = localParts(value instanceof Date ? value : new Date(value));
    return `${formatBs(adToBs(local.year, local.month, local.day))} BS`;
  } catch {
    return "";
  }
}

/** The search box takes free text; it must not be able to inject a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
  Field icons.
  ------------
  Drawn from the same 24x24 stroked set the sidebar and the sales screen use,
  so the filter bar reads as part of the application rather than as a pasted-in
  widget.
*/
const CALENDAR =
  "M8 3v3m8-3v3M4 9h16M5 6h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1z";
const FILTER = "M4 7h16M6 12h12M9 17h6";
const CARD =
  "M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z";
const SEARCH = "M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z";
const LIST = "M4 6h16M4 12h16M4 18h10";
const COIN =
  "M12 3v18m4-14.2c-.9-1-2.5-1.6-4.5-1.6-2.8 0-4.5 1.2-4.5 3s1.7 2.7 4.5 3.2 4.5 1.4 4.5 3.2-1.7 3-4.5 3c-2 0-3.6-.6-4.5-1.6";

/**
 * A filter field's label: small icon, small caps-ish text.
 *
 * `htmlFor` is omitted for the date fields on purpose - `DualDateField`
 * renders several inputs under one heading, so there is no single control for
 * a label to point at, and a label pointing at the wrong one is worse than a
 * plain heading.
 */
function FilterLabel({
  icon,
  htmlFor,
  children,
}: {
  icon: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      <svg
        className="h-3.5 w-3.5 shrink-0 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
      {children}
    </>
  );

  const className =
    "mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600";

  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {content}
    </label>
  ) : (
    <p className={className}>{content}</p>
  );
}

/**
 * One status filter chip.
 *
 * Deliberately identical to the sales register's, down to the dot colours, so
 * the two lists filter the same way and look like they do.
 */
function StatusChip({
  href,
  label,
  active,
  tone,
}: {
  href: string;
  label: string;
  active: boolean;
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
