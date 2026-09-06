import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { resolveViewScope } from "@/lib/branch-scope";
import { formatExpiry, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { getExpiryAlerts, getStockAlerts, SALES_WINDOW_DAYS } from "@/lib/alerts";
import {
  EXPIRY_LABEL,
  EXPIRY_TONE,
  STOCK_LABEL,
  STOCK_TONE,
  type ExpirySeverity,
  type StockSeverity,
} from "@/lib/alert-rules";
import {
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const TABS = [
  { key: "expiry", label: "Expiring" },
  { key: "stock", label: "Reorder" },
  { key: "dead", label: "Not moving" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * The alert centre.
 *
 * Phase 1 answered "is stock below N?" and "does this expire within N days?".
 * Both questions are here answered with the context that makes them
 * actionable: how fast the item actually sells, how many days of cover that
 * leaves, and how much money is genuinely at risk rather than merely nearby.
 */
export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; severity?: string; page?: string; branch?: string }>;
}) {
  const user = await requirePagePermission("report:read");
  const params = await searchParams;
  const scope = await withDbRead(() => resolveViewScope(user, params.branch));

  const tab = (TABS.find((t) => t.key === params.tab)?.key ?? "expiry") as TabKey;
  const page = Math.max(1, Number(params.page) || 1);
  const canSeeMoney = can(user.role, "report:financial");
  const canBuy = can(user.role, "purchase:write");

  // Both sides are needed for the tab counts, whichever tab is showing.
  const [expiry, stock] = await withDbRead(() =>
    Promise.all([
      getExpiryAlerts({
        severity: params.severity as ExpirySeverity | undefined,
        page: tab === "expiry" ? page : 1,
        pageSize: PAGE_SIZE,
        scope,
      }),
      getStockAlerts({
        severity: tab === "stock" ? (params.severity as StockSeverity | undefined) : undefined,
        deadOnly: tab === "dead",
        page: tab === "expiry" ? 1 : page,
        pageSize: PAGE_SIZE,
        scope,
      }),
    ]),
  );

  const urgent =
    expiry.counts.expired +
    expiry.counts.critical +
    stock.counts.out +
    stock.counts.critical;

  const tabCounts: Record<TabKey, number> = {
    expiry: expiry.counts.expired + expiry.counts.critical + expiry.counts.warning,
    stock: stock.counts.out + stock.counts.critical + stock.counts.low,
    dead: stock.deadStockCount,
  };

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={`Graded against the last ${SALES_WINDOW_DAYS} days of sales, so a slow mover and a fast one are judged differently.`}
        actions={
          canBuy ? (
            <Link href="/purchases/new" className="btn-primary">
              New purchase
            </Link>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Needs action today"
          value={integer(urgent)}
          hint="Expired, out of stock, or about to be"
          tone={urgent > 0 ? "danger" : "default"}
        />
        <StatCard
          label="Expired on shelf"
          value={integer(expiry.counts.expired)}
          hint="Blocked from billing"
          tone={expiry.counts.expired > 0 ? "danger" : "default"}
        />
        <StatCard
          label="Out of stock"
          value={integer(stock.counts.out)}
          hint={`${stock.counts.critical} more run out before restock`}
          tone={stock.counts.out > 0 ? "warning" : "default"}
        />
        {canSeeMoney ? (
          <StatCard
            label="Value at risk"
            value={money(expiry.totalValueAtRisk)}
            hint="Stock that will not sell before it expires"
            tone={expiry.totalValueAtRisk > 0 ? "warning" : "default"}
          />
        ) : (
          <StatCard
            label="Not moving"
            value={integer(stock.deadStockCount)}
            hint={`No sale in ${SALES_WINDOW_DAYS} days`}
          />
        )}
      </div>

      <Card className="mt-4 mb-4 p-4">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((entry) => (
            <Link
              key={entry.key}
              href={`/alerts?tab=${entry.key}`}
              className={cx(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === entry.key
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {entry.label}
              <span
                className={cx(
                  "tnum rounded-full px-1.5 py-0.5 text-[10px]",
                  tab === entry.key ? "bg-white/20" : "bg-white",
                )}
              >
                {tabCounts[entry.key]}
              </span>
            </Link>
          ))}

          {params.severity ? (
            <Link
              href={`/alerts?tab=${tab}`}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              Clear filter
            </Link>
          ) : null}
        </div>
      </Card>

      {tab === "expiry" ? (
        <ExpiryTable
          result={expiry}
          page={page}
          showMoney={canSeeMoney}
          activeSeverity={params.severity}
        />
      ) : (
        <StockTable
          result={stock}
          page={page}
          tab={tab}
          showMoney={canSeeMoney}
          activeSeverity={params.severity}
          canBuy={canBuy}
        />
      )}
    </>
  );
}

function ExpiryTable({
  result,
  page,
  showMoney,
  activeSeverity,
}: {
  result: Awaited<ReturnType<typeof getExpiryAlerts>>;
  page: number;
  showMoney: boolean;
  activeSeverity?: string;
}) {
  const severities: ExpirySeverity[] = ["expired", "critical", "warning", "watch"];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Expiring stock</h2>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {severities.map((severity) => (
            <Link
              key={severity}
              href={`/alerts?tab=expiry&severity=${severity}`}
              className={cx(
                "badge",
                EXPIRY_TONE[severity],
                activeSeverity === severity && "ring-2",
              )}
            >
              {EXPIRY_LABEL[severity]} · {result.counts[severity]}
            </Link>
          ))}
        </div>
      </div>

      {result.rows.length === 0 ? (
        <EmptyState
          title="Nothing expiring"
          description="No lot is inside the alert window. This is the state you want."
        />
      ) : (
        <>
          <TableWrap>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Medicine</th>
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th">Status</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Sells/day</th>
                {showMoney ? <th className="th text-right">At risk</th> : null}
                <th className="th">From</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((row) => (
                <tr key={row.batchId} className="hover:bg-slate-50">
                  <td className="td font-medium text-slate-900">{row.medicineName}</td>
                  <td className="td font-mono text-xs text-slate-600">
                    {row.batchNumber}
                  </td>
                  <td className="td whitespace-nowrap text-slate-600">
                    {formatExpiry(row.expiryDate)}
                    <span className="block text-[11px] text-slate-400">
                      {row.daysRemaining < 0
                        ? `${Math.abs(row.daysRemaining)} days ago`
                        : `in ${row.daysRemaining} days`}
                    </span>
                  </td>
                  <td className="td">
                    <span className={cx("badge", EXPIRY_TONE[row.severity])}>
                      {EXPIRY_LABEL[row.severity]}
                    </span>
                  </td>
                  <td className="td tnum text-right font-medium">
                    {integer(row.quantity)}
                  </td>
                  <td className="td tnum text-right text-slate-600">
                    {row.salesRate > 0 ? row.salesRate.toFixed(2) : "—"}
                  </td>
                  {showMoney ? (
                    <td className="td tnum text-right">
                      <span
                        className={
                          row.valueAtRisk > 0
                            ? "font-semibold text-rose-600"
                            : "text-slate-400"
                        }
                      >
                        {money(row.valueAtRisk)}
                      </span>
                      {row.valueAtRisk > 0 && row.valueAtRisk < row.stockValue ? (
                        <span className="block text-[11px] font-normal text-slate-400">
                          of {money(row.stockValue)}
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                  <td className="td text-xs">
                    {row.grnId ? (
                      <Link
                        href={`/purchases/${row.grnId}`}
                        className="font-mono text-brand-700 hover:underline"
                      >
                        {row.grnNo || "GRN"}
                      </Link>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            page={page}
            totalPages={Math.max(1, Math.ceil(result.total / PAGE_SIZE))}
            total={result.total}
            baseHref={`/alerts?tab=expiry${activeSeverity ? `&severity=${activeSeverity}` : ""}`}
          />
        </>
      )}
    </Card>
  );
}

function StockTable({
  result,
  page,
  tab,
  showMoney,
  activeSeverity,
  canBuy,
}: {
  result: Awaited<ReturnType<typeof getStockAlerts>>;
  page: number;
  tab: TabKey;
  showMoney: boolean;
  activeSeverity?: string;
  canBuy: boolean;
}) {
  const isDead = tab === "dead";
  const severities: StockSeverity[] = ["out", "critical", "low", "overstocked"];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {isDead ? "Stock that is not moving" : "What to reorder"}
        </h2>
        {!isDead ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {severities.map((severity) => (
              <Link
                key={severity}
                href={`/alerts?tab=stock&severity=${severity}`}
                className={cx(
                  "badge",
                  STOCK_TONE[severity],
                  activeSeverity === severity && "ring-2",
                )}
              >
                {STOCK_LABEL[severity]} · {result.counts[severity]}
              </Link>
            ))}
          </div>
        ) : showMoney ? (
          <span className="ml-auto text-xs text-slate-500">
            {money(result.deadStockValue)} tied up
          </span>
        ) : null}
      </div>

      {result.rows.length === 0 ? (
        <EmptyState
          title={isDead ? "Everything is moving" : "Nothing needs ordering"}
          description={
            isDead
              ? `Every medicine with stock has sold within the last ${SALES_WINDOW_DAYS} days.`
              : "Every medicine is holding enough cover for now."
          }
        />
      ) : (
        <>
          <TableWrap>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Medicine</th>
                <th className="th">Category</th>
                <th className="th text-right">In stock</th>
                <th className="th text-right">Sells/day</th>
                <th className="th text-right">Days cover</th>
                <th className="th">Status</th>
                {isDead ? (
                  <th className="th">Last sold</th>
                ) : (
                  <th className="th text-right">Order</th>
                )}
                {showMoney ? <th className="th text-right">Value</th> : null}
                {canBuy && !isDead ? <th className="th"></th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((row) => (
                <tr key={row.medicineId} className="hover:bg-slate-50">
                  <td className="td">
                    <p className="font-medium text-slate-900">{row.medicineName}</p>
                    {row.genericName ? (
                      <p className="text-xs text-slate-500">{row.genericName}</p>
                    ) : null}
                  </td>
                  <td className="td text-slate-600">{row.category}</td>
                  <td className="td tnum text-right font-medium">
                    {integer(row.stockQuantity)}
                    <span className="ml-1 text-xs font-normal text-slate-400 capitalize">
                      {row.unit}
                    </span>
                  </td>
                  <td className="td tnum text-right text-slate-600">
                    {row.salesRate > 0 ? row.salesRate.toFixed(2) : "—"}
                  </td>
                  <td className="td tnum text-right">
                    {row.assessment.daysOfCover === null ? (
                      <span
                        className="text-slate-400"
                        title="No sales history, so cover cannot be computed"
                      >
                        n/a
                      </span>
                    ) : (
                      <span className="text-slate-700">
                        {row.assessment.daysOfCover.toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="td">
                    <span className={cx("badge", STOCK_TONE[row.assessment.severity])}>
                      {STOCK_LABEL[row.assessment.severity]}
                    </span>
                    {row.assessment.basis === "reorder-level" ? (
                      <span
                        className="ml-1 text-[11px] text-slate-400"
                        title="Judged on the flat reorder level because there is no sales history"
                      >
                        (level)
                      </span>
                    ) : null}
                  </td>
                  {isDead ? (
                    <td className="td text-slate-600">
                      {row.daysSinceLastSale === null
                        ? "Never sold"
                        : `${row.daysSinceLastSale} days ago`}
                    </td>
                  ) : (
                    <td className="td tnum text-right">
                      {row.assessment.suggestedOrderQuantity > 0 ? (
                        <span className="font-semibold text-brand-700">
                          {integer(row.assessment.suggestedOrderQuantity)}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {showMoney ? (
                    <td className="td tnum text-right text-slate-600">
                      {money(row.stockValue)}
                    </td>
                  ) : null}
                  {canBuy && !isDead ? (
                    <td className="td text-right">
                      <Link
                        href={`/purchases/new?medicineId=${row.medicineId}`}
                        className="text-xs font-medium text-brand-700 hover:underline"
                      >
                        Add stock
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            page={page}
            totalPages={Math.max(1, Math.ceil(result.total / PAGE_SIZE))}
            total={result.total}
            baseHref={`/alerts?tab=${tab}${activeSeverity ? `&severity=${activeSeverity}` : ""}`}
          />
        </>
      )}
    </Card>
  );
}
