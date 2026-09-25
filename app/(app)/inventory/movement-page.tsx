import type { ReactNode } from "react";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { resolveViewScope } from "@/lib/branch-scope";
import { listBranches } from "@/lib/branches";
import {
  addDays,
  dateRangeFromStrings,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { integer, money } from "@/lib/format";
import { MOVEMENT_KIND_LABELS, type MovementKind } from "@/lib/movement-kinds";
import { readLedger } from "@/lib/stock-ledger";
import { can } from "@/lib/roles";
import { DualDateField } from "@/components/DualDateField";
import {
  StockActionForm,
  type StockActionMode,
} from "@/components/inventory/StockActionForm";
import { StockLedger } from "@/components/inventory/StockLedger";
import { Card, PageHeader, StatCard, cx } from "@/components/ui";
import { ModuleTabs } from "@/components/ModuleScaffold";
import { INVENTORY_TABS } from "./tabs";

const PAGE_SIZE = 50;

/**
 * The body every stock-movement screen shares.
 *
 * All five are one screen with different arguments: a date range, a ledger
 * filtered to some kinds, and - for the three that change stock rather than
 * only report it - a form above the list. Writing them separately would have
 * produced five date pickers that drift apart.
 *
 * The default range is the last thirty days rather than today. A stock ledger
 * is opened to answer "what happened to this", which is rarely a question
 * about the last six hours, and a screen that opens empty because nothing has
 * moved since breakfast reads as broken.
 */
export interface MovementScreenParams {
  from?: string;
  to?: string;
  q?: string;
  kind?: string;
  /** Exact lot number, narrower than the free-text search. */
  lot?: string;
  /** Supplier name, from the dropdown of suppliers that actually delivered. */
  supplier?: string;
  page?: string;
  branch?: string;
}

export async function MovementScreen({
  title,
  subtitle,
  active,
  direction,
  kinds,
  mode,
  params,
  emptyTitle,
  emptyDescription,
  footer,
  actions,
  statLabels,
}: {
  title: string;
  subtitle: string;
  /** href of the tab this screen owns. */
  active: string;
  direction?: "in" | "out" | "both";
  /** The movement kinds this screen is about. Omit for everything. */
  kinds?: readonly MovementKind[];
  /** When set, the screen can also record this kind of movement. */
  mode?: StockActionMode;
  params: MovementScreenParams;
  emptyTitle: string;
  emptyDescription: string;
  footer?: ReactNode;
  /** Extra buttons for the header, before the shared "Current stock" link. */
  actions?: ReactNode;
  /**
   * Screen-specific wording for the summary tiles.
   *
   * "Units" means something different on each of these screens - received,
   * dispensed, written off - and a shared tile that says only "Units" makes
   * the reader supply the verb from the page title. Defaults keep the four
   * screens that have no strong preference identical.
   */
  statLabels?: { units?: string; kinds?: string };
}): Promise<ReactNode> {
  const user = await requirePagePermission("batch:read");
  const canSeeMoney = can(user.role, "report:financial");
  const canWrite = can(user.role, "batch:write");

  const today = toDateInputValue();
  const todayDate = parseLocalDate(today);
  const monthAgo = todayDate ? toDateInputValue(addDays(todayDate, -29)) : today;

  // Read backwards rather than returning nothing, the same way the sales
  // screen does: a range typed the wrong way round is a typo, not a request
  // for an empty list.
  const askedFrom = (params.from ?? monthAgo).trim();
  const askedTo = (params.to ?? today).trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const page = Math.max(1, Number(params.page) || 1);
  const search = (params.q ?? "").trim();
  const lot = (params.lot ?? "").trim();
  const supplier = (params.supplier ?? "").trim();

  // Only the kinds this screen is about may be picked from its dropdown, so a
  // hand-edited URL cannot make the Damaged screen list every sale.
  const kind =
    params.kind && kinds?.includes(params.kind as MovementKind)
      ? (params.kind as MovementKind)
      : null;

  const scope = await resolveViewScope(user, params.branch);
  const { start, end } = dateRangeFromStrings(from, to);

  const [ledger, branches] = await Promise.all([
    readLedger({
      scope,
      start: start ?? new Date(0),
      end: end ?? new Date(),
      direction,
      kinds: kind ? [kind] : kinds,
      search,
      lot,
      supplier,
    }),
    // Only the transfer screen needs them, and only it pays for the query.
    mode === "transfer" ? listBranches(user, false) : Promise.resolve([]),
  ]);

  const shown = ledger.entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (search) baseQuery.set("q", search);
  if (kind) baseQuery.set("kind", kind);
  if (lot) baseQuery.set("lot", lot);
  if (supplier) baseQuery.set("supplier", supplier);
  const baseHref = baseQuery.toString()
    ? `${active}?${baseQuery.toString()}`
    : active;

  const showForm = Boolean(mode && canWrite);

  /*
    Suppliers that actually appear in this range, not every supplier on file.

    A dropdown listing forty suppliers of whom three delivered this month is a
    dropdown where every other choice returns nothing. Taken from the rows
    already read rather than a second query - the ledger is in memory, and the
    answer is a property of it.
  */
  const suppliers = [
    ...new Set(
      ledger.entries.map((entry) => entry.supplier).filter((name) => name),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const filtersOn = Boolean(
    search || kind || lot || supplier || from !== monthAgo || to !== today,
  );

  const canExport =
    can(user.role, "report:export") && can(user.role, "report:financial");
  const exportHref = (format: "xlsx" | "csv" | "pdf") =>
    `/api/export?report=stock-movements&format=${format}&from=${encodeURIComponent(
      from,
    )}&to=${encodeURIComponent(to)}&direction=${direction ?? "both"}`;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {/*
              Export follows the screen's own direction, so Stock In downloads
              receipts and Stock Out downloads issues - one report read two
              ways rather than two reports to keep in step. It carries the date
              range but not the search: a ledger export is the range, and one
              silently narrowed to whatever was typed in the box would be a
              file nobody can reconcile against anything.
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

                <div className="absolute left-0 z-20 mt-1.5 w-56 max-w-[calc(100vw-2rem)] overflow-hidden sm:right-0 sm:left-auto rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5">
                  <p className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                    {from} – {to}
                  </p>
                  {(["xlsx", "csv", "pdf"] as const).map((format) => (
                    <a
                      key={format}
                      href={exportHref(format)}
                      className="flex items-center justify-between px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50 hover:text-brand-700"
                    >
                      {format === "xlsx" ? "Excel" : format.toUpperCase()}
                      <span className="font-mono text-[11px] text-slate-400">
                        .{format}
                      </span>
                    </a>
                  ))}
                </div>
              </details>
            ) : null}

            {actions}

            <Link href="/inventory" className="btn-secondary">
              Current stock
            </Link>
          </>
        }
      />

      <ModuleTabs tabs={INVENTORY_TABS} active={active} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Movements" value={integer(ledger.entries.length)} />
        <StatCard
          label={statLabels?.units ?? "Units"}
          value={integer(ledger.totalUnits)}
          hint={`Over ${from} to ${to}`}
        />
        {canSeeMoney ? (
          <StatCard label="Value at cost" value={money(ledger.totalValue)} />
        ) : null}
        <StatCard
          label={statLabels?.kinds ?? "Kinds"}
          value={integer(ledger.byKind.length)}
          hint={
            ledger.byKind.length > 0
              ? (MOVEMENT_KIND_LABELS[ledger.byKind[0]!.kind] ?? "")
              : "Nothing in this range"
          }
        />
      </div>

      {/*
        The form sits above the ledger, because the person who opened this
        screen to record something should not have to scroll past a month of
        history to do it. Read-only roles never see it.
      */}
      {showForm ? (
        <div id="record" className="mb-4 scroll-mt-4">
          <StockActionForm
            mode={mode!}
            // The ledger filter doubles as the form's opening search, so
            // arriving from a medicine row lands with that name already typed.
            initialQuery={params.q ?? ""}
            branches={branches.map((branch) => ({
              id: branch.id,
              name: branch.name,
            }))}
          />
        </div>
      ) : null}

      <Card className="mb-4 p-3.5 sm:p-4">
        {/*
          One flat row of controls, bottom-aligned, matching the sales and
          returns registers. The bordered columns this used to be drew a box
          around "when" and a box around "what", which is not a distinction
          anybody reading a stock ledger is making.
        */}
        <form method="get" className="flex flex-wrap items-end gap-x-3 gap-y-3.5">
          {/* Wider than a date needs: each carries an AD box and a BS picker. */}
          <div className="w-full min-w-0 sm:w-[15rem]">
            <p className="label">From</p>
            <DualDateField
              id="from"
              name="from"
              defaultValue={from}
              compact
              aria-label="From"
            />
          </div>

          <div className="w-full min-w-0 sm:w-[15rem]">
            <p className="label">To</p>
            <DualDateField
              id="to"
              name="to"
              defaultValue={to}
              compact
              aria-label="To"
            />
          </div>

          {/* Only worth a control where the screen covers more than one kind. */}
          {kinds && kinds.length > 1 ? (
            <div className="w-full min-w-0 sm:w-[11rem]">
              <label htmlFor="kind" className="label">
                Movement
              </label>
              <select
                id="kind"
                name="kind"
                defaultValue={kind ?? ""}
                className="input"
              >
                <option value="">All movements</option>
                {kinds.map((value) => (
                  <option key={value} value={value}>
                    {MOVEMENT_KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="w-full min-w-0 sm:w-[9rem]">
            <label htmlFor="lot" className="label">
              Lot
            </label>
            <input
              id="lot"
              name="lot"
              defaultValue={lot}
              placeholder="Batch no"
              className="input font-mono text-xs"
            />
          </div>

          {/*
            Only offered where a supplier is a meaningful thing to filter by.
            A stock-out screen listing dispensing and write-offs has none, and
            an empty dropdown is a control that only ever disappoints.
          */}
          {suppliers.length > 0 ? (
            <div className="w-full min-w-0 sm:w-[11rem]">
              <label htmlFor="supplier" className="label">
                Supplier
              </label>
              <select
                id="supplier"
                name="supplier"
                defaultValue={supplier}
                className="input"
              >
                <option value="">All suppliers</option>
                {suppliers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* The one field with no natural width: it takes what is left. */}
          <div className="min-w-[14rem] flex-1">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search}
              placeholder="Medicine, lot or reference"
              className="input"
            />
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary">
              Apply
            </button>
            {filtersOn ? (
              <Link href={active} className="btn-secondary whitespace-nowrap">
                Clear filters
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {/*
        What moved, by kind. A single "units" total hides the thing worth
        seeing - that half of last month's stock out was written off rather
        than sold - so the split is shown wherever there is more than one.
      */}
      {ledger.byKind.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {ledger.byKind.map((row) => (
            <Link
              key={row.kind}
              href={`${active}?${new URLSearchParams({
                ...(from ? { from } : {}),
                ...(to ? { to } : {}),
                ...(search ? { q: search } : {}),
                kind: row.kind,
              }).toString()}`}
              className={cx(
                "rounded-lg border px-3 py-2 text-xs transition-colors",
                kind === row.kind
                  ? "border-brand-300 bg-brand-50 text-brand-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              <span className="font-medium">{MOVEMENT_KIND_LABELS[row.kind]}</span>
              <span className="tnum ml-2 font-semibold text-slate-900">
                {integer(row.units)}
              </span>
              {canSeeMoney ? (
                <span className="tnum ml-1.5 text-slate-400">
                  {money(row.value)}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      <StockLedger
        entries={shown}
        page={page}
        pageSize={PAGE_SIZE}
        total={ledger.entries.length}
        baseHref={baseHref}
        canSeeMoney={canSeeMoney}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        emptyAction={
          <Link href={active} className="btn-secondary">
            Reset filters
          </Link>
        }
      />

      {footer}
    </>
  );
}
