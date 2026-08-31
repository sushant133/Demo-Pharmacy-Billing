import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { resolveViewScope } from "@/lib/branch-scope";
import { dateRangeFromStrings } from "@/lib/dates";
import { integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  getMedicinePerformance,
  getPaymentMix,
  getProfitSummary,
  getPurchaseVsSales,
  getSalesSeries,
  granularityFor,
} from "@/lib/analytics";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import { REPORT_DESCRIPTIONS, REPORT_KEYS, REPORT_LABELS } from "@/lib/export/reports";
import { Card, PageHeader, StatCard, TableWrap } from "@/components/ui";
import { LineChart } from "@/components/charts/LineChart";
import { BarChart } from "@/components/charts/BarChart";
import { RangeFilter, resolveRange } from "@/components/reports/RangeFilter";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Sales and profit dashboard.
 *
 * A server component throughout: the charts are server-rendered SVG, so the
 * page ships no charting library and no client JavaScript. Every figure comes
 * from lib/analytics.ts, which values profit against the cost captured on each
 * sale line rather than the batch's cost today.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string; by?: string; branch?: string }>;
}) {
  const user = await requirePagePermission("report:financial");
  const params = await searchParams;
  const scope = await resolveViewScope(user, params.branch);

  const range = resolveRange(params);
  const { start, end } = dateRangeFromStrings(range.from, range.to);
  const from = start ?? new Date();
  const to = end ?? new Date();

  const rankBy =
    params.by === "revenue" ? "revenue" : params.by === "units" ? "units" : "profit";

  const [summary, series, topMedicines, paymentMix, stockFlow] = await Promise.all([
    getProfitSummary(from, to, scope),
    getSalesSeries(from, to, granularityFor(from, to), scope),
    getMedicinePerformance(from, to, { limit: 8, by: rankBy, scope }),
    getPaymentMix(from, to, scope),
    getPurchaseVsSales(from, to, scope),
  ]);

  const canExport = can(user.role, "report:export");
  const exportQuery = `from=${range.from}&to=${range.to}`;

  return (
    <>
      <PageHeader
        title="Sales & profit"
        subtitle={`${range.label} · profit measured against the cost captured on each sale`}
      />

      <RangeFilter
        basePath="/reports"
        range={range}
        extra={
          canExport ? (
            <>
              <a
                href={`/api/export?report=sales-register&format=xlsx&${exportQuery}`}
                className="btn-secondary text-xs"
              >
                Export Excel
              </a>
              <a
                href={`/api/export?report=sales-register&format=pdf&${exportQuery}`}
                className="btn-secondary text-xs"
              >
                Export PDF
              </a>
            </>
          ) : null
        }
      />

      {summary.hasIncompleteCostData ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Some bills in this range were rung up before cost tracking began, so
          their cost shows as zero and profit is <strong>overstated</strong> for
          those. Figures from here on are complete.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Revenue"
          value={money(summary.revenue)}
          hint="Excludes VAT"
          tone="brand"
        />
        <StatCard
          label="Gross profit"
          value={money(summary.grossProfit)}
          hint={`Cost of goods ${money(summary.cost)}`}
        />
        <StatCard
          label="Margin"
          value={`${summary.marginPercent.toFixed(1)}%`}
          hint="Profit as a share of revenue"
        />
        <StatCard
          label="Bills"
          value={integer(summary.billCount)}
          hint={`Average ${money(summary.averageBill)}`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Revenue and profit over time
          </h2>
          <p className="mt-0.5 mb-3 text-xs text-slate-500">
            Both in rupees, on one scale.
          </p>

          <LineChart
            caption={`Revenue and gross profit, ${range.label}`}
            labels={series.map((point) => point.label)}
            series={[
              {
                key: "revenue",
                label: "Revenue",
                color: "--color-series-1",
                values: series.map((point) => point.revenue),
              },
              {
                key: "profit",
                label: "Gross profit",
                color: "--color-series-2",
                values: series.map((point) => point.profit),
              },
            ]}
          />
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Where it went</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Collected from customers" value={money(summary.collected)} />
              <Row label="VAT (owed to IRD)" value={money(summary.vat)} />
              <Row label="Discounts given" value={money(summary.discount)} />
              <Row label="Cost of goods sold" value={money(summary.cost)} />
              <div className="flex justify-between border-t border-slate-200 pt-2">
                <dt className="font-medium text-slate-900">Gross profit</dt>
                <dd className="tnum font-bold text-slate-900">
                  {money(summary.grossProfit)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Stock flow</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Purchased (at cost)" value={money(stockFlow.purchased)} />
              <Row label="Sold (at cost)" value={money(stockFlow.soldAtCost)} />
              <div className="flex justify-between border-t border-slate-200 pt-2">
                <dt className="text-slate-600">Net stock change</dt>
                <dd
                  className={`tnum font-semibold ${
                    stockFlow.netStockChange >= 0 ? "text-slate-900" : "text-amber-700"
                  }`}
                >
                  {stockFlow.netStockChange >= 0 ? "+" : ""}
                  {money(stockFlow.netStockChange)}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              Positive means stock grew over the period.
            </p>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Top medicines by {rankBy === "units" ? "units sold" : rankBy}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Bill discounts allocated across lines.
              </p>
            </div>
            <div className="flex gap-1.5">
              {(["profit", "revenue", "units"] as const).map((option) => (
                <Link
                  key={option}
                  href={`/reports?from=${range.from}&to=${range.to}&by=${option}`}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                    rankBy === option
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {option}
                </Link>
              ))}
            </div>
          </div>

          <BarChart
            caption={`Top medicines by ${rankBy}, ${range.label}`}
            isMoney={rankBy !== "units"}
            valueHeader={rankBy === "units" ? "Units" : "Rupees"}
            data={topMedicines.map((medicine) => ({
              label: medicine.medicineName,
              sublabel: `${integer(medicine.unitsSold)} units · ${medicine.marginPercent.toFixed(0)}% margin`,
              value:
                rankBy === "units"
                  ? medicine.unitsSold
                  : rankBy === "revenue"
                    ? medicine.revenue
                    : medicine.profit,
              detail: `${money(medicine.revenue)} revenue, ${money(medicine.profit)} profit`,
            }))}
          />
        </Card>

        <Card className="overflow-hidden">
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            How customers paid
          </h2>
          {paymentMix.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              No sales in this period.
            </p>
          ) : (
            <TableWrap>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Mode</th>
                  <th className="th text-right">Bills</th>
                  <th className="th text-right">Amount</th>
                  <th className="th text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paymentMix.map((row) => (
                  <tr key={row.mode}>
                    <td className="td">
                      {PAYMENT_MODE_LABELS[row.mode as PaymentMode] ?? row.mode}
                    </td>
                    <td className="td tnum text-right">{row.billCount}</td>
                    <td className="td tnum text-right">{money(row.amount)}</td>
                    <td className="td tnum text-right text-slate-500">
                      {row.percent.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      {canExport ? (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Download a report</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Excel keeps numbers numeric and sortable; PDF is fixed for filing.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {REPORT_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {REPORT_LABELS[key]}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {REPORT_DESCRIPTIONS[key]}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {(["xlsx", "csv", "pdf"] as const).map((format) => (
                    <a
                      key={format}
                      href={`/api/export?report=${key}&format=${format}&${exportQuery}`}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-600 uppercase hover:bg-slate-50 hover:text-brand-700"
                    >
                      {format === "xlsx" ? "Excel" : format}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tnum text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
