import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs } from "@/lib/bs-date";
import { config } from "@/lib/config";
import { amount, formatTime, integer, money } from "@/lib/format";
import { getDashboardSummary } from "@/lib/reports";
import { getExpiryAlerts, getStockAlerts } from "@/lib/alerts";
import {
  EXPIRY_LABEL,
  STOCK_LABEL,
  type ExpirySeverity,
  type StockSeverity,
} from "@/lib/alert-rules";
import {
  getCategoryMix,
  getHourlySales,
  getMedicinePerformance,
  getPaymentMix,
  getProfitSummary,
  getPurchaseVsSales,
  getSalesSeries,
} from "@/lib/analytics";
import { addDays, localDayRange, localParts, startOfLocalDay } from "@/lib/dates";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import { Badge, Card, EmptyState, TableWrap, cx } from "@/components/ui";
import { Sparkline } from "@/components/charts/Sparkline";
import { LineChart } from "@/components/charts/LineChart";
import { BarChart } from "@/components/charts/BarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { ColumnChart } from "@/components/charts/ColumnChart";
import { can } from "@/lib/roles";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const TREND_DAYS = 14;

const PAYMENT_COLOR: Record<string, string> = {
  cash: "--color-series-3",
  card: "--color-series-1",
  esewa: "--color-series-2",
  khalti: "--color-series-4",
  credit: "--color-series-5",
};

const SERIES_COLORS = [
  "--color-series-1",
  "--color-series-2",
  "--color-series-3",
  "--color-series-4",
  "--color-series-5",
];

/**
 * The morning screen: today's take, the shape of the last two weeks, and
 * the two lists that might need acting on before the shutter goes up.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const [user, params] = await Promise.all([
    requirePagePermission("report:read"),
    searchParams,
  ]);

  const today = localDayRange();
  const showMoney = can(user.role, "report:financial");
  const scope = await withDbRead(() => resolveViewScope(user));
  const trendStart = startOfLocalDay(addDays(new Date(), -(TREND_DAYS - 1)));
  const emptySeries = Promise.resolve([]);
  const emptyMix = Promise.resolve([]);

  const [
    summary,
    expiryAlerts,
    stockAlerts,
    profit,
    series,
    payments,
    hourly,
    topMedicines,
    categories,
    stockFlow,
  ] = await withDbRead(() =>
    Promise.all([
      getDashboardSummary(scope),
      getExpiryAlerts({ pageSize: 5, scope }),
      getStockAlerts({ pageSize: 6, scope }),
      showMoney ? getProfitSummary(today.start, today.end, scope) : Promise.resolve(null),
      showMoney ? getSalesSeries(trendStart, today.end, "day", scope) : emptySeries,
      getPaymentMix(today.start, today.end, scope),
      getHourlySales(today.start, today.end, scope),
      showMoney
        ? getMedicinePerformance(trendStart, today.end, { limit: 6, by: "revenue", scope })
        : emptyMix,
      showMoney ? getCategoryMix(trendStart, today.end, scope, 5) : emptyMix,
      showMoney ? getPurchaseVsSales(trendStart, today.end, scope) : Promise.resolve(null),
    ]),
  );

  const firstName = user.name.split(" ")[0] ?? user.name;
  const now = new Date();
  const bs = adToBs(...dateParts(now));
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: config.timezone,
  }).format(now);
  const currentHour = localHour(now);

  const needsOrdering = stockAlerts.counts.out + stockAlerts.counts.critical + stockAlerts.counts.low;
  const expiringSoon = expiryAlerts.counts.critical + expiryAlerts.counts.warning;
  const attention =
    expiryAlerts.counts.expired +
    expiryAlerts.counts.critical +
    stockAlerts.counts.out +
    stockAlerts.counts.critical;

  const stockIssues = stockAlerts.rows
    .filter((row) =>
      row.assessment.severity === "out" ||
      row.assessment.severity === "critical" ||
      row.assessment.severity === "low",
    )
    .slice(0, 5);

  const trendRevenues = series.map((point) => point.revenue);
  const trendAverage =
    trendRevenues.length > 0
      ? trendRevenues.reduce((sum, value) => sum + value, 0) / trendRevenues.length
      : 0;

  const highlightHour = hourly.findIndex((point) => point.hour === currentHour);

  return (
    <>
      <section className="dash-hero relative mb-6 overflow-hidden rounded-2xl px-5 py-6 text-white sm:px-7 sm:py-7">
        <div className="login-blister absolute inset-0 opacity-70" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
              {scope.label}
              <span className="mx-1.5 text-white/30">·</span>
              as of {formatTime(now)}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Good {greeting()}, {firstName}
            </h1>
            <p className="mt-1.5 text-sm text-slate-300">
              {dateLabel}
              <span className="mx-1.5 text-white/25">&middot;</span>
              <span className="text-slate-200">{formatBs(bs)}</span>
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {can(user.role, "sale:create") ? (
                <Link href="/billing" className="btn-primary shadow-lg shadow-brand-900/30">
                  New sale
                  <kbd className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">
                    F2
                  </kbd>
                </Link>
              ) : null}
              {can(user.role, "purchase:write") ? (
                <Link
                  href="/purchases/new"
                  className="inline-flex items-center rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/15 hover:bg-white/15"
                >
                  Receive stock
                </Link>
              ) : null}
              <Link
                href="/alerts"
                className="inline-flex items-center rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/15 hover:bg-white/15"
              >
                Alerts
                {attention > 0 ? (
                  <span className="ml-1.5 rounded-full bg-rose-400/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {attention}
                  </span>
                ) : null}
              </Link>
            </div>
          </div>

          <div className="w-full shrink-0 lg:w-[22rem]">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
              Taken today
            </p>
            <p className="tnum mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">
              {money(summary.today.salesTotal)}
            </p>
            <p className="mt-1 text-xs text-slate-300">
              {integer(summary.today.billCount)} bill
              {summary.today.billCount === 1 ? "" : "s"}
              <span className="mx-1.5 text-white/25">·</span>
              {integer(summary.today.itemCount)} items
              <span className="mx-1.5 text-white/25">·</span>
              avg {money(summary.today.averageBill)}
            </p>
            {showMoney && trendRevenues.length > 1 ? (
              <div className="mt-4">
                <Sparkline
                  values={trendRevenues}
                  startLabel={series[0]?.label}
                  endLabel="Today"
                  caption={`Daily taxable revenue over the last ${series.length} days.`}
                  gradientId="dash-hero-spark"
                  labelClassName="text-slate-300"
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {params.denied ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          You do not have access to that screen.
        </div>
      ) : null}

      {expiryAlerts.counts.expired > 0 ? (
        <ExpiredBanner count={expiryAlerts.counts.expired} />
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Bills today"
          value={integer(summary.today.billCount)}
          hint={`Average ${money(summary.today.averageBill)}`}
          href="/sales"
          icon="M7 8h10M7 12h6M6 21V5a2 2 0 012-2h8a2 2 0 012 2v16l-3-2-3 2-3-2-3 2z"
          tone="brand"
        />
        {profit ? (
          <Kpi
            label="Gross profit"
            value={money(profit.grossProfit)}
            hint={`${profit.marginPercent.toFixed(1)}% margin · VAT excluded`}
            href="/reports"
            icon="M3 17l6-6 4 4 8-8M14 7h7v7"
            tone="default"
            extra={<MarginRing percent={profit.marginPercent} />}
          />
        ) : (
          <Kpi
            label="Stock value"
            value={money(summary.inventoryValue)}
            hint="At cost"
            icon="M3 7h18M3 12h18M3 17h18"
          />
        )}
        <Kpi
          label="Needs ordering"
          value={integer(needsOrdering)}
          hint={
            stockAlerts.counts.out > 0
              ? `${stockAlerts.counts.out} already out`
              : "Above reorder, or close"
          }
          href="/alerts?tab=stock"
          icon="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          tone={stockAlerts.counts.out + stockAlerts.counts.critical > 0 ? "warning" : "default"}
        />
        <Kpi
          label="Expiring soon"
          value={integer(expiringSoon + expiryAlerts.counts.expired)}
          hint={
            showMoney && expiryAlerts.totalValueAtRisk > 0
              ? `${money(expiryAlerts.totalValueAtRisk)} at risk`
              : `${summary.expiryWindowDays}-day window`
          }
          href="/alerts?tab=expiry"
          icon="M12 8v4l2.5 2.5M12 21a9 9 0 100-18 9 9 0 000 18z"
          tone={
            expiryAlerts.counts.expired + expiryAlerts.counts.critical > 0 ? "danger" : "default"
          }
        />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Card className="p-4 sm:p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Revenue and profit
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Last {TREND_DAYS} days, taxable amount, one scale.
                {trendAverage > 0 ? (
                  <>
                    {" "}
                    <span className="tnum font-medium text-slate-700">
                      {money(trendAverage)}
                    </span>{" "}
                    a day on average.
                  </>
                ) : null}
              </p>
            </div>
            <Link href="/reports" className="text-xs font-medium text-brand-700 hover:text-brand-800">
              Full report &rarr;
            </Link>
          </div>
          {showMoney ? (
            <LineChart
              caption={`Revenue and gross profit over the last ${TREND_DAYS} days`}
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
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">
              Sales figures are limited on this account.
            </p>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">How they paid</h2>
            <span className="tnum text-xs text-slate-500">{money(summary.today.salesTotal)}</span>
          </div>
          <DonutChart
            caption="Today's payments by mode"
            centerLabel={
              payments.find((row) => row.mode === "cash")
                ? amount(payments.find((row) => row.mode === "cash")!.amount)
                : undefined
            }
            centerHint={payments.some((row) => row.mode === "cash") ? "cash in drawer" : "today"}
            formatValue={money}
            slices={payments.map((row) => ({
              key: row.mode,
              label: PAYMENT_MODE_LABELS[row.mode as PaymentMode] ?? row.mode,
              value: row.amount,
              color: PAYMENT_COLOR[row.mode] ?? "--color-series-5",
            }))}
          />
          {payments.length > 0 ? (
            <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
              {payments.find((row) => row.mode === "cash") ? (
                <>
                  Cash should be in the drawer. Card, wallets and credit settle
                  elsewhere.
                </>
              ) : (
                "Nothing was taken in cash today."
              )}
            </p>
          ) : null}
        </Card>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Card className="p-4 sm:p-5 lg:col-span-2">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Today, hour by hour</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Collected from customers, VAT included. The current hour is the
              darker column.
            </p>
          </div>
          <ColumnChart
            caption="Today's collections by hour"
            highlightIndex={highlightHour >= 0 ? highlightHour : undefined}
            data={hourly.map((point) => ({
              label: point.label,
              value: point.amount,
              detail: `${point.billCount} bill${point.billCount === 1 ? "" : "s"}`,
            }))}
          />
        </Card>

        <Card className="p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-slate-900">What is selling</h2>
          <p className="mt-0.5 mb-3 text-xs text-slate-500">
            Last {TREND_DAYS} days, by category.
          </p>
          {categories.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Categories appear once bills are rung up.
            </p>
          ) : (
            <DonutChart
              caption={`Revenue by category, last ${TREND_DAYS} days`}
              formatValue={money}
              slices={categories.map((row, index) => ({
                key: row.category,
                label: row.category,
                value: row.revenue,
                color: SERIES_COLORS[index] ?? "--color-series-5",
              }))}
            />
          )}
        </Card>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Card className="p-4 sm:p-5 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Top medicines</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Last {TREND_DAYS} days, ranked by revenue.
              </p>
            </div>
            <Link href="/reports" className="text-xs font-medium text-brand-700 hover:text-brand-800">
              Rank by profit &rarr;
            </Link>
          </div>
          <BarChart
            caption={`Top medicines by revenue, last ${TREND_DAYS} days`}
            valueHeader="Revenue"
            data={topMedicines.map((medicine) => ({
              label: medicine.medicineName,
              sublabel: `${integer(medicine.unitsSold)} units · ${medicine.marginPercent.toFixed(0)}% margin`,
              value: medicine.revenue,
              detail: `${money(medicine.profit)} profit`,
            }))}
          />
        </Card>

        <div className="space-y-4">
          <AlertList
            title="Needs ordering"
            href="/alerts?tab=stock"
            empty="Every medicine is above its reorder level."
            items={stockIssues.map((row) => ({
              key: row.medicineId,
              name: row.medicineName,
              meta:
                row.assessment.daysOfCover !== null
                  ? `${row.assessment.daysOfCover} days of cover`
                  : `${integer(row.stockQuantity)} ${row.unit} left`,
              tone: row.assessment.severity,
              badge: STOCK_LABEL[row.assessment.severity],
              href: can(user.role, "purchase:write")
                ? `/purchases/new?medicineId=${row.medicineId}`
                : undefined,
            }))}
          />
          <AlertList
            title="Expiring on the shelf"
            href="/alerts?tab=expiry"
            empty="Nothing on the shelf is near its expiry."
            items={expiryAlerts.rows.map((row) => ({
              key: row.batchId,
              name: row.medicineName,
              meta:
                row.daysRemaining < 0
                  ? `${Math.abs(row.daysRemaining)} days past`
                  : `${row.daysRemaining} days left · ${integer(row.quantity)} left`,
              tone: row.severity,
              badge: EXPIRY_LABEL[row.severity],
            }))}
          />
        </div>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Recent sales</h2>
            <Link href="/sales" className="text-xs font-medium text-brand-700 hover:text-brand-800">
              View all
            </Link>
          </div>
          {summary.recentSales.length === 0 ? (
            <EmptyState
              title="No sales yet"
              description="Bills will appear here as soon as the counter starts ringing them up."
            />
          ) : (
            <TableWrap minWidth="36rem" pinFirst>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  {/*
                    The dashboard's bill list sits in the narrower of two
                    columns on a desktop, so it is squeezed long before the
                    viewport is. Bill, amount and time are what makes it a
                    "what just happened" list; the rest folds under the number.
                  */}
                  <th className="th">Bill</th>
                  <th className="th">Customer</th>
                  <th className="th text-right">Items</th>
                  <th className="th">Paid by</th>
                  <th className="th text-right">Amount</th>
                  <th className="th text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.recentSales.map((sale) => (
                  <tr key={sale.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/sales/${sale.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {sale.billNo}
                      </Link>
                    </td>
                    <td className="td">
                      {sale.customerName || <span className="text-slate-400">Walk-in</span>}
                    </td>
                    <td className="td tnum text-right text-slate-600">
                      {sale.itemCount}
                    </td>
                    <td className="td">
                      <Badge tone="slate">
                        {PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ?? sale.paymentMode}
                      </Badge>
                    </td>
                    <td className="td tnum text-right font-medium text-slate-900">
                      {money(sale.totalAmount)}
                    </td>
                    <td className="td tnum text-right text-slate-500">
                      {formatTime(sale.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Inventory health</h2>
            <dl className="mt-4 space-y-3">
              <HealthRow
                label="Stock value"
                value={money(summary.inventoryValue)}
                hint="At cost"
              />
              <HealthRow
                label="Needs reorder"
                value={integer(summary.lowStockCount)}
                tone={summary.lowStockCount > 0 ? "warning" : undefined}
              />
              <HealthRow
                label={`Expiring in ${summary.expiryWindowDays} days`}
                value={integer(summary.expiringSoonCount)}
                tone={summary.expiringSoonCount > 0 ? "warning" : undefined}
              />
              <HealthRow
                label="Not moving"
                value={integer(stockAlerts.deadStockCount)}
                hint={
                  showMoney && stockAlerts.deadStockValue > 0
                    ? money(stockAlerts.deadStockValue)
                    : undefined
                }
              />
              {stockFlow ? (
                <HealthRow
                  label="Net stock this fortnight"
                  value={`${stockFlow.netStockChange >= 0 ? "+" : ""}${money(stockFlow.netStockChange)}`}
                  hint={`Bought ${money(stockFlow.purchased)} · sold at cost ${money(stockFlow.soldAtCost)}`}
                  tone={stockFlow.netStockChange < 0 ? "warning" : undefined}
                />
              ) : null}
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Jump to</h2>
            <ul className="mt-3 grid grid-cols-2 gap-2">
              <Jump href="/billing" label="Billing" />
              <Jump href="/medicines" label="Medicines" />
              <Jump href="/batches" label="Batches" />
              <Jump href="/purchases" label="Purchases" />
              <Jump href="/reports" label="Reports" />
              <Jump href="/branches" label="Branches" />
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function dateParts(instant: Date): [number, number, number] {
  const local = localParts(instant, config.timezone);
  return [local.year, local.month, local.day];
}

function localHour(instant: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: config.timezone,
  }).format(instant);
  return Number(hour) % 24;
}

function Kpi({
  label,
  value,
  hint,
  href,
  icon,
  tone = "default",
  extra,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  icon: string;
  tone?: "default" | "brand" | "warning" | "danger";
  extra?: ReactNode;
}) {
  const tones: Record<string, string> = {
    default: "border-slate-200",
    brand: "border-brand-200 bg-brand-50/50",
    warning: "border-amber-200 bg-amber-50/60",
    danger: "border-rose-200 bg-rose-50/60",
  };
  const iconTone: Record<string, string> = {
    default: "bg-slate-100 text-slate-600",
    brand: "bg-brand-100 text-brand-700",
    warning: "bg-amber-100 text-amber-700",
    danger: "bg-rose-100 text-rose-700",
  };

  const body = (
    <div className={cx("card h-full p-4", tones[tone], href && "transition-shadow hover:shadow-md")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
        <span className={cx("flex h-8 w-8 items-center justify-center rounded-lg", iconTone[tone])}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
          </svg>
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="tnum text-2xl font-semibold text-slate-900 sm:text-3xl">{value}</p>
        {extra}
      </div>
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );

  return href ? (
    <Link href={href} className="block focus-visible:rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

function MarginRing({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = (clamped / 100) * c;
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10 shrink-0" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--color-chart-grid)" strokeWidth="4" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="var(--color-series-3)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  );
}

function AlertList({
  title,
  href,
  empty,
  items,
}: {
  title: string;
  href: string;
  empty: string;
  items: Array<{
    key: string;
    name: string;
    meta: string;
    tone: StockSeverity | ExpirySeverity;
    badge: string;
    href?: string;
  }>;
}) {
  const toneClass: Record<string, "rose" | "amber" | "slate"> = {
    out: "rose",
    expired: "rose",
    critical: "rose",
    warning: "amber",
    low: "amber",
    watch: "slate",
  };

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <Link href={href} className="text-xs font-medium text-brand-700 hover:text-brand-800">
          Review
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.key} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                {item.href ? (
                  <Link
                    href={item.href}
                    className="truncate text-sm font-medium text-slate-900 hover:text-brand-700"
                  >
                    {item.name}
                  </Link>
                ) : (
                  <p className="truncate text-sm font-medium text-slate-900">{item.name}</p>
                )}
                <p className="tnum truncate text-[11px] text-slate-500">{item.meta}</p>
              </div>
              <Badge tone={toneClass[item.tone] ?? "slate"}>{item.badge}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HealthRow({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right">
        <p className={cx("tnum text-sm font-semibold", tone === "warning" ? "text-amber-800" : "text-slate-900")}>
          {value}
        </p>
        {hint ? <p className="tnum text-[11px] text-slate-400">{hint}</p> : null}
      </dd>
    </div>
  );
}

function Jump({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <Link
        href={href}
        className="block rounded-lg bg-slate-50 px-3 py-2 text-center text-xs font-medium text-slate-700 ring-1 ring-slate-200/80 ring-inset hover:bg-white hover:text-brand-800 hover:ring-brand-200"
      >
        {label}
      </Link>
    </li>
  );
}

function ExpiredBanner({ count }: { count: number }) {
  return (
    <Link
      href="/alerts?tab=expiry&severity=expired"
      className="mb-4 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 transition-colors hover:bg-rose-100"
    >
      <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
        />
      </svg>
      <span className="flex-1">
        <strong className="font-semibold">
          {count} batch{count === 1 ? "" : "es"}
        </strong>{" "}
        {count === 1 ? "still holds" : "still hold"} stock past the expiry date. Billing already
        refuses them &mdash; take them off the shelf.
      </span>
      <span className="hidden text-xs font-medium whitespace-nowrap sm:inline">Review &rarr;</span>
    </Link>
  );
}

function greeting(): string {
  const hour = new Date().getUTCHours() + 5.75;
  const local = ((hour % 24) + 24) % 24;
  if (local < 12) return "morning";
  if (local < 17) return "afternoon";
  return "evening";
}
