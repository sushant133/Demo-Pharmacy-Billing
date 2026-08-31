import type { PipelineStage } from "mongoose";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { onceTtl, scopeCacheKey } from "@/lib/ttl-cache";
import { Sale } from "@/models/Sale";
import { Purchase } from "@/models/Purchase";

/**
 * Sales and profit analytics.
 *
 * Two conventions run through everything here, and both matter:
 *
 * 1. **Revenue means the taxable amount, not the total collected.** VAT is
 *    money held for the government; counting it as revenue would inflate every
 *    figure on the dashboard by 13%.
 *
 * 2. **Profit uses the cost captured on the sale line**, not the batch's cost
 *    today. Posting a repeat delivery blends a lot's cost by weighted average,
 *    so looking it up now would restate history. `Sale.items.unitCost` is
 *    frozen at the moment of sale for exactly this reason.
 *
 * Bill-level discounts are allocated back to lines in proportion to each line's
 * share of the bill, so per-medicine profit stays honest instead of quietly
 * ignoring a 10% counter discount.
 */

/** Buckets a date range into day, week or month labels. */
export type Granularity = "day" | "week" | "month";

const FORMAT_BY_GRANULARITY: Record<Granularity, string> = {
  day: "%Y-%m-%d",
  week: "%G-W%V",
  month: "%Y-%m",
};

/** Choose a sensible bucket size so a chart never renders 400 columns. */
export function granularityFor(from: Date, to: Date): Granularity {
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  if (days <= 62) return "day";
  if (days <= 400) return "week";
  return "month";
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Only completed sales count; voided bills are excluded everywhere. */
function saleMatch(from: Date, to: Date, scope?: BranchScope): PipelineStage.Match {
  return {
    $match: {
      createdAt: { $gte: from, $lt: to },
      voidedAt: null,
      ...branchFilter(scope),
    },
  };
}

export interface ProfitSummary {
  /** Taxable amount: what the shop actually earned, VAT excluded. */
  revenue: number;
  /** Cost of goods sold. */
  cost: number;
  /** revenue - cost. */
  grossProfit: number;
  /** grossProfit / revenue, as a percentage. 0 when revenue is 0. */
  marginPercent: number;
  discount: number;
  vat: number;
  /** Total the customers actually handed over, VAT included. */
  collected: number;
  billCount: number;
  unitCount: number;
  averageBill: number;
  /** True when some sales predate cost tracking, so profit is understated. */
  hasIncompleteCostData: boolean;
}

export async function getProfitSummary(
  from: Date,
  to: Date,
  scope?: BranchScope,
): Promise<ProfitSummary> {
  await connectDB();

  const [row] = await Sale.aggregate([
    saleMatch(from, to, scope),
    {
      $group: {
        _id: null,
        revenue: { $sum: "$taxableAmount" },
        cost: { $sum: "$totalCost" },
        discount: { $sum: "$discount" },
        vat: { $sum: "$vatAmount" },
        collected: { $sum: "$totalAmount" },
        billCount: { $sum: 1 },
        unitCount: { $sum: { $sum: "$items.quantity" } },
        // A sale with revenue but no recorded cost predates Phase 3.
        missingCost: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ["$taxableAmount", 0] }, { $lte: ["$totalCost", 0] }] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const stats = (row ?? {}) as Record<string, number | undefined>;
  const revenue = round2(stats.revenue ?? 0);
  const cost = round2(stats.cost ?? 0);
  const billCount = stats.billCount ?? 0;
  const grossProfit = round2(revenue - cost);

  return {
    revenue,
    cost,
    grossProfit,
    marginPercent: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    discount: round2(stats.discount ?? 0),
    vat: round2(stats.vat ?? 0),
    collected: round2(stats.collected ?? 0),
    billCount,
    unitCount: stats.unitCount ?? 0,
    averageBill: billCount > 0 ? round2(revenue / billCount) : 0,
    hasIncompleteCostData: (stats.missingCost ?? 0) > 0,
  };
}

export interface SeriesPoint {
  /** Bucket key, e.g. 2026-08-14. */
  key: string;
  /** Human label for the axis. */
  label: string;
  revenue: number;
  cost: number;
  profit: number;
  billCount: number;
}

/**
 * Revenue / cost / profit over time.
 *
 * Empty buckets are filled in so the line has no misleading gaps - a day with
 * no sales is a real zero, not missing data.
 */
export async function getSalesSeries(
  from: Date,
  to: Date,
  granularity: Granularity = granularityFor(from, to),
  scope?: BranchScope,
): Promise<SeriesPoint[]> {
  await connectDB();

  const rows = await Sale.aggregate([
    saleMatch(from, to, scope),
    {
      $group: {
        _id: {
          $dateToString: {
            format: FORMAT_BY_GRANULARITY[granularity],
            date: "$createdAt",
            timezone: config.timezone,
          },
        },
        revenue: { $sum: "$taxableAmount" },
        cost: { $sum: "$totalCost" },
        billCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byKey = new Map(
    (rows as Array<{ _id: string; revenue: number; cost: number; billCount: number }>).map(
      (row) => [row._id, row],
    ),
  );

  const points: SeriesPoint[] = [];
  for (const { key, label } of enumerateBuckets(from, to, granularity)) {
    const row = byKey.get(key);
    const revenue = round2(row?.revenue ?? 0);
    const cost = round2(row?.cost ?? 0);
    points.push({
      key,
      label,
      revenue,
      cost,
      profit: round2(revenue - cost),
      billCount: row?.billCount ?? 0,
    });
  }

  return points;
}

/**
 * Every bucket label between two dates, so gaps render as zeros.
 * Uses the business timezone, matching how the aggregation grouped them.
 */
function enumerateBuckets(
  from: Date,
  to: Date,
  granularity: Granularity,
): Array<{ key: string; label: string }> {
  const tz = config.timezone;
  const out: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();

  const dayParts = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    return parts; // YYYY-MM-DD
  };

  const shortLabel = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "2-digit",
      month: "short",
    }).format(date);

  const monthLabel = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      month: "short",
      year: "2-digit",
    }).format(date);

  // Walk a day at a time and collapse into the requested bucket. Ranges here
  // are at most a few years, so this stays cheap and avoids calendar edge
  // cases around month lengths and ISO week numbering.
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) {
    const date = new Date(t);
    const iso = dayParts(date);

    let key: string;
    let label: string;

    if (granularity === "day") {
      key = iso;
      label = shortLabel(date);
    } else if (granularity === "month") {
      key = iso.slice(0, 7);
      label = monthLabel(date);
    } else {
      const { year, week } = isoWeek(iso);
      key = `${year}-W${String(week).padStart(2, "0")}`;
      label = shortLabel(date);
    }

    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }

  return out;
}

/** ISO-8601 week number, matching MongoDB's %G-%V grouping. */
function isoWeek(isoDate: string): { year: number; week: number } {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  // Thursday of the current week determines the ISO year.
  const dayNumber = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNumber + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week =
    1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

export interface MedicinePerformance {
  medicineId: string;
  medicineName: string;
  unitsSold: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number;
  billCount: number;
}

export type RankBy = "profit" | "revenue" | "units";

/**
 * Per-medicine performance.
 *
 * The bill-level discount is pushed down to each line in proportion to that
 * line's share of the bill, so a medicine sold on a heavily discounted bill is
 * not credited with revenue the shop never received.
 */
export async function getMedicinePerformance(
  from: Date,
  to: Date,
  options?: { limit?: number; by?: RankBy; scope?: BranchScope },
): Promise<MedicinePerformance[]> {
  await connectDB();

  const limit = options?.limit ?? 10;
  const by = options?.by ?? "profit";

  const sortKey =
    by === "revenue" ? "revenue" : by === "units" ? "unitsSold" : "profit";

  const rows = await Sale.aggregate([
    saleMatch(from, to, options?.scope),
    { $unwind: "$items" },
    {
      $addFields: {
        // Guard the divide: a fully discounted bill can have subtotal 0.
        lineShare: {
          $cond: [
            { $gt: ["$subtotal", 0] },
            { $divide: ["$items.subtotal", "$subtotal"] },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        lineNetRevenue: {
          $subtract: [
            "$items.subtotal",
            { $multiply: ["$discount", "$lineShare"] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$items.medicineId",
        medicineName: { $last: "$items.medicineName" },
        unitsSold: { $sum: "$items.quantity" },
        revenue: { $sum: "$lineNetRevenue" },
        cost: { $sum: "$items.lineCost" },
        bills: { $addToSet: "$_id" },
      },
    },
    {
      $addFields: {
        profit: { $subtract: ["$revenue", "$cost"] },
        billCount: { $size: "$bills" },
      },
    },
    { $sort: { [sortKey]: -1 } },
    { $limit: limit },
    { $project: { bills: 0 } },
  ]);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const revenue = round2(Number(row.revenue ?? 0));
    const cost = round2(Number(row.cost ?? 0));
    const profit = round2(revenue - cost);
    return {
      medicineId: String(row._id),
      medicineName: String(row.medicineName ?? "Unknown"),
      unitsSold: Number(row.unitsSold ?? 0),
      revenue,
      cost,
      profit,
      marginPercent: revenue > 0 ? round2((profit / revenue) * 100) : 0,
      billCount: Number(row.billCount ?? 0),
    };
  });
}

export interface PaymentMixRow {
  mode: string;
  billCount: number;
  amount: number;
  percent: number;
}

/** How customers paid, over the range. */
export async function getPaymentMix(
  from: Date,
  to: Date,
  scope?: BranchScope,
): Promise<PaymentMixRow[]> {
  await connectDB();

  const rows = await Sale.aggregate([
    saleMatch(from, to, scope),
    {
      $group: {
        _id: "$paymentMode",
        billCount: { $sum: 1 },
        amount: { $sum: "$totalAmount" },
      },
    },
    { $sort: { amount: -1 } },
  ]);

  const typed = rows as Array<{ _id: string; billCount: number; amount: number }>;
  const total = typed.reduce((sum, row) => sum + row.amount, 0);

  return typed.map((row) => ({
    mode: row._id,
    billCount: row.billCount,
    amount: round2(row.amount),
    percent: total > 0 ? round2((row.amount / total) * 100) : 0,
  }));
}

export interface PurchaseVsSales {
  purchased: number;
  soldAtCost: number;
  /** Positive means stock grew over the period. */
  netStockChange: number;
}

export interface HourlyPoint {
  hour: number;
  label: string;
  amount: number;
  billCount: number;
}

/**
 * Fill every hour in the shop window, including quiet hours as zeros.
 * Hours with data outside 8–20 expand the window so a late bill still plots.
 */
export function fillHourlyBuckets(
  rows: Array<{ hour: number; amount: number; billCount: number }>,
  shopOpen = 8,
  shopClose = 20,
): HourlyPoint[] {
  const byHour = new Map(rows.map((row) => [row.hour, row]));
  const dataHours = rows.filter((row) => row.billCount > 0).map((row) => row.hour);
  const start = Math.min(shopOpen, ...dataHours, shopOpen);
  const end = Math.max(shopClose, ...dataHours, shopClose);

  const points: HourlyPoint[] = [];
  for (let hour = start; hour <= end; hour++) {
    const row = byHour.get(hour);
    points.push({
      hour,
      label: String(hour).padStart(2, "0"),
      amount: round2(row?.amount ?? 0),
      billCount: row?.billCount ?? 0,
    });
  }
  return points;
}

/** Bills grouped by local hour of day, for the "today so far" column chart. */
export async function getHourlySales(
  from: Date,
  to: Date,
  scope?: BranchScope,
): Promise<HourlyPoint[]> {
  await connectDB();

  const rows = await Sale.aggregate([
    saleMatch(from, to, scope),
    {
      $group: {
        _id: { $hour: { date: "$createdAt", timezone: config.timezone } },
        amount: { $sum: "$totalAmount" },
        billCount: { $sum: 1 },
      },
    },
  ]);

  return fillHourlyBuckets(
    (rows as Array<{ _id: number; amount: number; billCount: number }>).map((row) => ({
      hour: row._id,
      amount: row.amount,
      billCount: row.billCount,
    })),
  );
}

export interface CategoryMixRow {
  category: string;
  revenue: number;
  units: number;
  percent: number;
}

/** Revenue by medicine category, so the mix of the shop is visible at a glance. */
export async function getCategoryMix(
  from: Date,
  to: Date,
  scope?: BranchScope,
  limit = 6,
): Promise<CategoryMixRow[]> {
  await connectDB();

  const rows = await Sale.aggregate([
    saleMatch(from, to, scope),
    { $unwind: "$items" },
    {
      $lookup: {
        from: "medicines",
        localField: "items.medicineId",
        foreignField: "_id",
        as: "med",
      },
    },
    {
      $group: {
        _id: { $ifNull: [{ $first: "$med.category" }, "Other"] },
        revenue: { $sum: "$items.subtotal" },
        units: { $sum: "$items.quantity" },
      },
    },
    { $sort: { revenue: -1 } },
  ]);

  const typed = rows as Array<{ _id: string; revenue: number; units: number }>;
  const total = typed.reduce((sum, row) => sum + row.revenue, 0);
  const head = typed.slice(0, limit);
  const rest = typed.slice(limit);
  const restRevenue = rest.reduce((sum, row) => sum + row.revenue, 0);
  const restUnits = rest.reduce((sum, row) => sum + row.units, 0);

  const out: CategoryMixRow[] = head.map((row) => ({
    category: row._id || "Other",
    revenue: round2(row.revenue),
    units: row.units,
    percent: total > 0 ? round2((row.revenue / total) * 100) : 0,
  }));

  if (restRevenue > 0) {
    const existing = out.find((row) => row.category === "Other");
    if (existing) {
      existing.revenue = round2(existing.revenue + restRevenue);
      existing.units += restUnits;
      existing.percent = total > 0 ? round2((existing.revenue / total) * 100) : 0;
    } else {
      out.push({
        category: "Other",
        revenue: round2(restRevenue),
        units: restUnits,
        percent: total > 0 ? round2((restRevenue / total) * 100) : 0,
      });
    }
  }

  return out;
}

/** What went out to suppliers against what left the shelf, at cost. */
export async function getPurchaseVsSales(
  from: Date,
  to: Date,
  scope?: BranchScope,
): Promise<PurchaseVsSales> {
  await connectDB();

  const [purchaseAgg, saleAgg] = await Promise.all([
    Purchase.aggregate([
      {
        $match: {
          status: "posted",
          receivedDate: { $gte: from, $lt: to },
          ...branchFilter(scope),
        },
      },
      { $group: { _id: null, total: { $sum: "$taxableAmount" } } },
    ]),
    Sale.aggregate([
      saleMatch(from, to, scope),
      { $group: { _id: null, total: { $sum: "$totalCost" } } },
    ]),
  ]);

  const purchased = round2(
    (purchaseAgg[0] as { total?: number } | undefined)?.total ?? 0,
  );
  const soldAtCost = round2((saleAgg[0] as { total?: number } | undefined)?.total ?? 0);

  return { purchased, soldAtCost, netStockChange: round2(purchased - soldAtCost) };
}

/**
 * Units sold per medicine over a window - the input to days-of-cover.
 * Returned as a plain map so the alert layer can look rates up cheaply.
 */
export async function getUnitsSoldByMedicine(
  from: Date,
  to: Date,
  scope?: BranchScope,
): Promise<Map<string, number>> {
  return onceTtl(
    `units:${from.getTime()}:${to.getTime()}:${scopeCacheKey(scope)}`,
    20_000,
    async () => {
      await connectDB();

      const rows = await Sale.aggregate([
        saleMatch(from, to, scope),
        { $unwind: "$items" },
        { $group: { _id: "$items.medicineId", units: { $sum: "$items.quantity" } } },
      ]);

      return new Map(
        (rows as Array<{ _id: unknown; units: number }>).map((row) => [
          String(row._id),
          row.units,
        ]),
      );
    },
  );
}

/** When each medicine last sold, for dead-stock detection. */
export async function getLastSaleByMedicine(
  scope?: BranchScope,
): Promise<Map<string, Date>> {
  return onceTtl(`last-sale:${scopeCacheKey(scope)}`, 30_000, async () => {
    await connectDB();

    // Dead-stock only cares that nothing moved recently. Scanning the entire
    // sales history on every dashboard click was the slow path.
    const since = new Date(Date.now() - 548 * 86_400_000);

    const rows = await Sale.aggregate([
      { $match: { voidedAt: null, createdAt: { $gte: since }, ...branchFilter(scope) } },
      { $unwind: "$items" },
      { $group: { _id: "$items.medicineId", lastSoldAt: { $max: "$createdAt" } } },
    ]);

    return new Map(
      (rows as Array<{ _id: unknown; lastSoldAt: Date }>).map((row) => [
        String(row._id),
        new Date(row.lastSoldAt),
      ]),
    );
  });
}
