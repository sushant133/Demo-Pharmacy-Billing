import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchMatch, resolveViewScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { describeExpiry, formatExpiry, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  STOCK_FILTERS,
  STOCK_FILTER_LABELS,
  daysToExpiry,
  isLowStock,
  isStockFilter,
  matchesStockFilter,
  stockStatus,
  type StockFilter,
} from "@/lib/stock-status";
import { Batch } from "@/models/Batch";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { ModuleTabs } from "@/components/ModuleScaffold";
import { INVENTORY_TABS } from "./tabs";

export const metadata: Metadata = { title: "Inventory" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * One medicine's shelf position, rolled up from its lots.
 *
 * `quantity` is everything physically held; `sellable` is the part that has
 * not expired. Keeping both is the point - a single "on hand" figure that
 * quietly includes expired boxes tells the counter it can serve a customer it
 * cannot, and tells the owner they hold stock they actually have to destroy.
 */
interface StockRow {
  medicineId: string;
  name: string;
  sku: string;
  genericName: string;
  unit: string;
  reorderLevel: number | null;
  quantity: number;
  sellable: number;
  expiredUnits: number;
  lots: number;
  stockValue: number;
  saleValue: number;
  minCost: number;
  maxCost: number;
  minSale: number;
  maxSale: number;
  /** Earliest expiry among lots that have not already expired. */
  nearestExpiry: Date | null;
}

/**
 * Inventory hub - what is on the shelf right now.
 *
 * Batches answers "which lot?"; this answers "how much of what, worth what,
 * and is any of it a problem?". Stock lives on batches, so every figure is
 * rolled up per medicine rather than stored, and it is read through the branch
 * scope: two outlets each hold their own units, and adding them up is only
 * correct when the user is viewing all branches.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    low?: string;
    status?: string;
    page?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("batch:read");
  const params = await searchParams;
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);
  const canSeeMoney = can(user.role, "report:financial");

  // `?low=1` was this screen's only filter before the status dropdown existed.
  // Old links and bookmarks keep working rather than silently showing everything.
  const status: StockFilter = isStockFilter(params.status)
    ? params.status
    : params.low === "1"
      ? "low"
      : "all";

  const rows = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const now = new Date();
    const sellableUnits = {
      $cond: [{ $gte: ["$expiryDate", now] }, "$quantity", 0],
    };

    return Batch.aggregate<StockRow>([
      { $match: { ...branchMatch(scope), quantity: { $gt: 0 } } },
      {
        $group: {
          _id: "$medicineId",
          quantity: { $sum: "$quantity" },
          sellable: { $sum: sellableUnits },
          expiredUnits: {
            $sum: { $cond: [{ $lt: ["$expiryDate", now] }, "$quantity", 0] },
          },
          lots: { $sum: 1 },
          stockValue: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
          saleValue: { $sum: { $multiply: ["$quantity", "$salePrice"] } },
          // Lots bought or priced differently are worth saying out loud: it is
          // the difference between "the price" and "one of the prices".
          minCost: { $min: "$costPrice" },
          maxCost: { $max: "$costPrice" },
          minSale: { $min: "$salePrice" },
          maxSale: { $max: "$salePrice" },
          // Only over lots that can still be sold. `$min` skips the nulls the
          // branch below produces, so an expired lot cannot become the date
          // the counter plans around.
          nearestExpiry: {
            $min: { $cond: [{ $gte: ["$expiryDate", now] }, "$expiryDate", null] },
          },
        },
      },
      {
        $lookup: {
          from: "medicines",
          localField: "_id",
          foreignField: "_id",
          as: "medicine",
        },
      },
      { $unwind: "$medicine" },
      {
        $project: {
          _id: 0,
          medicineId: { $toString: "$_id" },
          name: "$medicine.name",
          sku: { $ifNull: ["$medicine.sku", ""] },
          genericName: { $ifNull: ["$medicine.genericName", ""] },
          unit: "$medicine.unit",
          reorderLevel: "$medicine.reorderLevel",
          quantity: 1,
          sellable: 1,
          expiredUnits: 1,
          lots: 1,
          stockValue: { $round: ["$stockValue", 2] },
          saleValue: { $round: ["$saleValue", 2] },
          minCost: 1,
          maxCost: 1,
          minSale: 1,
          maxSale: 1,
          nearestExpiry: 1,
        },
      },
      { $sort: { name: 1 } },
    ]);
  });

  const needle = search.toLowerCase();
  const filtered = rows.filter((row) => {
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !row.genericName.toLowerCase().includes(needle) &&
      !row.sku.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return matchesStockFilter(row, status);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const lowCount = rows.filter(isLowStock).length;
  // Sellable, matching the On hand column, so the column sums to the tile.
  // What is physically present is this plus the expired tile beside it.
  const totalUnits = rows.reduce((sum, row) => sum + row.sellable, 0);
  const totalLots = rows.reduce((sum, row) => sum + row.lots, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.stockValue, 0);
  const totalRetail = rows.reduce((sum, row) => sum + row.saleValue, 0);
  const expiredUnits = rows.reduce((sum, row) => sum + row.expiredUnits, 0);
  // What the dead stock cost, valued at its own lots' average - the figure
  // somebody has to write off, not a units count they then have to price.
  const expiredValue = rows.reduce(
    (sum, row) =>
      sum + (row.quantity > 0 ? (row.stockValue / row.quantity) * row.expiredUnits : 0),
    0,
  );

  const baseQuery = new URLSearchParams();
  if (search) baseQuery.set("q", search);
  if (status !== "all") baseQuery.set("status", status);
  const filteredView = Boolean(search || status !== "all");

  const canExportValuation =
    can(user.role, "report:export") && can(user.role, "report:financial");
  const canAdjust = can(user.role, "batch:write");

  const statusHref = (next: StockFilter) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (next !== "all") query.set("status", next);
    return query.toString() ? `/inventory?${query.toString()}` : "/inventory";
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="On-hand stock rolled up per medicine, across every lot in the current branch scope."
        actions={
          <>
            {/*
              Stock valuation, which is what this screen *is* - one row per
              medicine, valued at cost. Point-in-time rather than dated, so it
              ignores the search and status filters above: an inventory
              valuation is the whole shelf or it is not a valuation, and one
              silently narrowed to "low stock" would be a figure somebody puts
              in a set of accounts.

              Gated on the financial permission because it exposes cost.
            */}
            {canExportValuation ? (
              <a
                href="/api/export?report=stock-valuation&format=xlsx"
                className="btn-secondary"
              >
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
              </a>
            ) : null}

            <Link href="/batches" className="btn-secondary">
              Browse lots
            </Link>
            {can(user.role, "purchase:write") ? (
              <Link href="/purchases/new" className="btn-primary">
                Receive stock
              </Link>
            ) : null}
          </>
        }
      />

      <div
        className={cx(
          "grid grid-cols-2 gap-3",
          expiredUnits > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        )}
      >
        <StatCard label="Medicines in stock" value={integer(rows.length)} />
        <StatCard
          label="Sellable units"
          value={integer(totalUnits)}
          hint={`${integer(totalLots)} lot${totalLots === 1 ? "" : "s"}`}
        />
        <StatCard
          label="At or below reorder"
          value={integer(lowCount)}
          hint="Set a reorder level on a medicine to track it"
          tone={lowCount > 0 ? "warning" : "default"}
          href={lowCount > 0 ? statusHref("low") : undefined}
        />
        {/*
          Expired stock earns a tile only when there is some, so a shop keeping
          on top of its dates sees four clean figures. Clicking it lists exactly
          the lines behind the number.
        */}
        {expiredUnits > 0 ? (
          <StatCard
            label="Expired on shelf"
            value={integer(expiredUnits)}
            hint={canSeeMoney ? `${money(expiredValue)} at cost` : "Units to pull"}
            tone="danger"
            href={statusHref("expired")}
          />
        ) : null}
        {canSeeMoney ? (
          <StatCard
            label="Stock value"
            value={money(totalValue)}
            hint={`At cost · ${money(totalRetail)} at retail`}
          />
        ) : (
          <StatCard label="Lots held" value={integer(totalLots)} />
        )}
      </div>

      <ModuleTabs tabs={INVENTORY_TABS} active="/inventory" />

      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_14rem_auto]"
          action="/inventory"
        >
          <div className="min-w-0">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Medicine, generic or code"
              className="input"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="status" className="label">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={status}
              className="input"
            >
              {STOCK_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {STOCK_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1 lg:flex-none">
              Apply
            </button>
            {filteredView ? (
              <Link href="/inventory" className="btn-secondary">
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {/*
        One-click versions of the Status dropdown above. They set the same key
        and keep the search, so the two controls cannot disagree - and they are
        drawn from STOCK_FILTERS, the same list the dropdown and the row badges
        come from, so a chip can never name a state the filter does not have.
      */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {STOCK_FILTERS.map((value) => (
          <StatusChip
            key={value}
            href={statusHref(value)}
            active={status === value}
            label={CHIP_LABELS[value]}
            tone={value}
          />
        ))}
      </div>

      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <EmptyState
            title={
              filteredView ? "No medicine matches this filter" : "Nothing on the shelf here"
            }
            description={
              filteredView
                ? "Try a different status, or clear the search."
                : "Stock appears once a purchase is posted."
            }
            action={
              filteredView ? (
                <Link href="/inventory" className="btn-secondary">
                  Reset filters
                </Link>
              ) : can(user.role, "purchase:write") ? (
                <Link href="/purchases/new" className="btn-primary">
                  Receive stock
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap minWidth="48rem" pinFirst pinLast>
              <thead>
                {/*
                  Four columns on a phone: what it is, how much is left,
                  whether that is a problem, and what to do. Price and expiry
                  are folded into the first two cells rather than dropped -
                  both are things a counter asks for - and return to columns
                  of their own from `sm` and `md`.
                */}
                <tr>
                  <th className="th">Medicine</th>
                  <th className="th text-right">On hand</th>
                  {canSeeMoney ? (
                    <th className="th text-right">
                      Purchase price
                    </th>
                  ) : null}
                  <th className="th text-right">
                    Selling price
                  </th>
                  <th className="th text-right">Reorder at</th>
                  <th className="th">Expiry</th>
                  <th className="th">Status</th>
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((row) => {
                  const state = stockStatus(row);
                  const days = daysToExpiry(row);
                  // Weighted averages over every unit held, expired included:
                  // expiry does not change what a box cost or is priced at, and
                  // this basis is what makes the columns sum to the value tile.
                  const avgCost = row.quantity > 0 ? row.stockValue / row.quantity : 0;
                  const avgSale = row.quantity > 0 ? row.saleValue / row.quantity : 0;
                  const mixedCost = row.minCost !== row.maxCost;
                  const mixedSale = row.minSale !== row.maxSale;
                  const margin =
                    avgSale > 0 ? ((avgSale - avgCost) / avgSale) * 100 : null;

                  return (
                    <tr key={row.medicineId} className="hover:bg-slate-50">
                      <td className="td">
                        <Link
                          href={`/batches?medicineId=${row.medicineId}`}
                          className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.genericName ? (
                          <span className="block text-[11px] text-slate-500">
                            {row.genericName}
                          </span>
                        ) : null}
                        {row.sku ? (
                          <span className="block font-mono text-[11px] tracking-wide text-slate-400">
                            {row.sku}
                          </span>
                        ) : null}
                      </td>

                      <td className="td text-right">
                        <span
                          className={cx(
                            "tnum",
                            state.status === "expired"
                              ? "font-semibold text-rose-600"
                              : isLowStock(row)
                                ? "font-semibold text-amber-700"
                                : "font-medium text-slate-900",
                          )}
                        >
                          {integer(row.sellable)}
                        </span>
                        <span className="ml-1 text-xs text-slate-400">{row.unit}</span>
                        {/*
                          Dead boxes sitting behind a healthy number. Said here
                          rather than folded into the total, because the total
                          is what somebody is about to promise a customer.
                        */}
                        {row.expiredUnits > 0 ? (
                          <span className="tnum block text-[11px] font-medium text-rose-600">
                            +{integer(row.expiredUnits)} expired
                          </span>
                        ) : null}
                        {/*
                          How many lots that figure is spread across, under the
                          figure itself rather than in a column of its own. As a
                          column it was a single digit holding a full table
                          track, and `hidden xl:table-cell` meant the one number
                          that says "this is four part-used boxes, not one" was
                          absent on every screen narrower than a desktop.
                        */}
                        <span className="tnum block text-[11px] text-slate-400">
                          {integer(row.lots)} lot{row.lots === 1 ? "" : "s"}
                        </span>
                      </td>

                      {canSeeMoney ? (
                        <td className="td tnum text-right">
                          <span className="text-slate-700">{money(avgCost)}</span>
                          {mixedCost ? (
                            <span
                              className="block text-[11px] text-slate-400"
                              title="The lots held were bought at different prices. This is their weighted average."
                            >
                              {money(row.minCost)}–{money(row.maxCost)}
                            </span>
                          ) : null}
                        </td>
                      ) : null}

                      <td className="td tnum text-right">
                        <span className="font-medium text-slate-900">
                          {money(avgSale)}
                        </span>
                        {mixedSale ? (
                          <span
                            className="block text-[11px] text-slate-400"
                            title="The lots held are priced differently. The till charges the one dispensed first."
                          >
                            {money(row.minSale)}–{money(row.maxSale)}
                          </span>
                        ) : null}
                        {canSeeMoney && margin != null ? (
                          <span
                            className={cx(
                              "block text-[11px]",
                              margin < 0 ? "font-medium text-rose-600" : "text-slate-400",
                            )}
                          >
                            {margin.toFixed(0)}% margin
                          </span>
                        ) : null}
                      </td>

                      <td className="td tnum text-right text-slate-500">
                        {row.reorderLevel == null ? "—" : integer(row.reorderLevel)}
                      </td>

                      <td className="td whitespace-nowrap">
                        {row.nearestExpiry ? (
                          <>
                            <span className="tnum block text-slate-700">
                              {formatExpiry(row.nearestExpiry)}
                            </span>
                            {days != null ? (
                              <span
                                className={cx(
                                  "block text-[11px]",
                                  days <= 30
                                    ? "font-medium text-orange-700"
                                    : days <= config.expiryAlertDays
                                      ? "text-amber-700"
                                      : "text-slate-400",
                                )}
                              >
                                {describeExpiry(days)}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-rose-600">All lots expired</span>
                        )}
                      </td>

                      <td className="td">
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>

                      <td className="td col-actions">
                        <ActionBar>
                          <ActionIcon
                            label="View lots"
                            icon="lots"
                            tone="primary"
                            href={`/batches?medicineId=${row.medicineId}`}
                          />
                          {/*
                            Carries the medicine name as the lot search, so the
                            adjustment screen opens with it already typed rather
                            than asking the user to retype what they just clicked.
                          */}
                          {canAdjust ? (
                            <ActionIcon
                              label="Adjust stock"
                              icon="adjust"
                              href={`/inventory/adjustments?q=${encodeURIComponent(row.name)}`}
                            />
                          ) : null}
                        </ActionBar>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={totalPages}
              total={filtered.length}
              baseHref={
                baseQuery.toString() ? `/inventory?${baseQuery.toString()}` : "/inventory"
              }
            />
          </>
        )}
      </Card>
    </>
  );
}

/**
 * Short chip labels.
 *
 * The dropdown's own labels are sentences - "At or below reorder", "Expiring
 * within 90 days" - which is right in a select and far too wide in a row of
 * chips. Same five states, said in one or two words; `STOCK_FILTER_LABELS`
 * stays the long form for the dropdown.
 */
const CHIP_LABELS: Record<StockFilter, string> = {
  all: "All",
  ok: "In stock",
  low: "Low stock",
  expiring: "Expiring",
  expired: "Expired",
};

/** One status filter chip, coloured to match the badge it filters to. */
function StatusChip({
  href,
  label,
  active,
  tone,
}: {
  href: string;
  label: string;
  active: boolean;
  tone: StockFilter;
}) {
  const dot: Record<StockFilter, string | null> = {
    all: null,
    ok: "bg-emerald-500",
    low: "bg-amber-500",
    expiring: "bg-orange-500",
    expired: "bg-rose-500",
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
      {dot[tone] ? (
        <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", dot[tone])} />
      ) : null}
      {label}
    </Link>
  );
}
