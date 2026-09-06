import type { Types } from "mongoose";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { addDays } from "@/lib/dates";
import {
  DEFAULT_EXPIRY_THRESHOLDS,
  assessStock,
  averageDailySales,
  expiryRank,
  expirySeverity,
  isDeadStock,
  stockRank,
  valueAtRisk,
  type ExpirySeverity,
  type StockAssessment,
  type StockSeverity,
} from "@/lib/alert-rules";
import { getLastSaleByMedicine, getUnitsSoldByMedicine } from "@/lib/analytics";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { pharmacyMatch } from "@/lib/tenant";
import { onceTtl, scopeCacheKey } from "@/lib/ttl-cache";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";

/**
 * The alert layer: joins what is on the shelf with how fast it moves, and runs
 * the pure rules in lib/alert-rules.ts over the result.
 *
 * The sales window is deliberately a *trailing* one (90 days by default). A
 * pharmacy's mix shifts with the season - antihistamines in spring, cough
 * syrup in winter - so a lifetime average would under-react to both.
 */

/** How much history the velocity figures are based on. */
export const SALES_WINDOW_DAYS = 90;

export interface ExpiringBatchAlert {
  batchId: string;
  batchNumber: string;
  medicineId: string;
  medicineName: string;
  unit: string;
  quantity: number;
  costPrice: number;
  salePrice: number;
  expiryDate: string;
  daysRemaining: number;
  severity: ExpirySeverity;
  stockValue: number;
  /** GRN this lot arrived on, for chasing a supplier return. */
  grnId: string | null;
  grnNo: string;
  /** Units per day this medicine sells, from the trailing window. */
  salesRate: number;
  /** Money likely to be lost: the part that cannot sell before expiry. */
  valueAtRisk: number;
}

export interface ExpiryAlertResult {
  rows: ExpiringBatchAlert[];
  total: number;
  counts: Record<ExpirySeverity, number>;
  /** Total cost value that will not sell before expiring. */
  totalValueAtRisk: number;
}

/**
 * Batches graded by urgency, worst first.
 *
 * Unlike Phase 1's flat "expiring within N days" list, each row carries the
 * medicine's actual sales rate and the money genuinely at risk - so a lot with
 * 400 units and no buyers sorts above one with 5 units that turns over weekly.
 */
export async function getExpiryAlerts(options?: {
  withinDays?: number;
  includeExpired?: boolean;
  severity?: ExpirySeverity;
  page?: number;
  pageSize?: number;
  scope?: BranchScope;
}): Promise<ExpiryAlertResult> {
  await connectDB();

  const withinDays = options?.withinDays ?? config.expiryAlertDays;
  const includeExpired = options?.includeExpired ?? true;
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 50;

  const now = new Date();
  const cutoff = addDays(now, withinDays);

  const match: Record<string, unknown> = {
    quantity: { $gt: 0 },
    expiryDate: includeExpired ? { $lte: cutoff } : { $gte: now, $lte: cutoff },
    ...branchFilter(options?.scope),
  };

  const [batches, salesByMedicine] = await Promise.all([
    Batch.find(match)
      .sort({ expiryDate: 1 })
      .populate<{
        medicineId: { _id: Types.ObjectId; name: string; unit?: string };
      }>("medicineId", "name unit")
      .lean(),
    getUnitsSoldByMedicine(addDays(now, -SALES_WINDOW_DAYS), now, options?.scope),
  ]);

  const dayMs = 86_400_000;

  const rows: ExpiringBatchAlert[] = batches.map((batch) => {
    const expiry = new Date(batch.expiryDate);
    const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / dayMs);
    const medicine = batch.medicineId as unknown as {
      _id: Types.ObjectId;
      name?: string;
      unit?: string;
    } | null;

    const medicineId = medicine ? String(medicine._id) : "";
    const rate = averageDailySales(
      salesByMedicine.get(medicineId) ?? 0,
      SALES_WINDOW_DAYS,
    );

    return {
      batchId: String(batch._id),
      batchNumber: batch.batchNumber,
      medicineId,
      medicineName: medicine?.name ?? "Unknown medicine",
      unit: medicine?.unit ?? "unit",
      quantity: batch.quantity,
      costPrice: batch.costPrice,
      salePrice: batch.salePrice,
      expiryDate: expiry.toISOString(),
      daysRemaining,
      severity: expirySeverity(daysRemaining, DEFAULT_EXPIRY_THRESHOLDS),
      stockValue: Math.round(batch.quantity * batch.costPrice * 100) / 100,
      grnId: batch.grnId ? String(batch.grnId) : null,
      grnNo: batch.grnNo ?? "",
      salesRate: rate,
      valueAtRisk: valueAtRisk(
        [{ quantity: batch.quantity, costPrice: batch.costPrice, daysRemaining }],
        rate,
      ),
    };
  });

  const counts = {
    expired: 0,
    critical: 0,
    warning: 0,
    watch: 0,
    ok: 0,
  } as Record<ExpirySeverity, number>;
  for (const row of rows) counts[row.severity] += 1;

  const filtered = options?.severity
    ? rows.filter((row) => row.severity === options.severity)
    : rows;

  // Worst severity first, then by the money actually at stake.
  filtered.sort(
    (a, b) =>
      expiryRank(a.severity) - expiryRank(b.severity) ||
      b.valueAtRisk - a.valueAtRisk ||
      a.daysRemaining - b.daysRemaining,
  );

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    counts,
    totalValueAtRisk:
      Math.round(rows.reduce((sum, row) => sum + row.valueAtRisk, 0) * 100) / 100,
  };
}

export interface StockAlert {
  medicineId: string;
  medicineName: string;
  genericName: string;
  unit: string;
  category: string;
  stockQuantity: number;
  reorderLevel: number;
  salesRate: number;
  assessment: StockAssessment;
  /** Days since this medicine last sold. null if it never has. */
  daysSinceLastSale: number | null;
  isDead: boolean;
  stockValue: number;
}

export interface StockAlertResult {
  rows: StockAlert[];
  total: number;
  counts: Record<StockSeverity, number>;
  deadStockCount: number;
  deadStockValue: number;
}

/**
 * Every medicine assessed against its own sales rate.
 *
 * Only sellable stock counts - expired lots are excluded, because stock that
 * cannot legally be dispensed is not stock, and counting it would mask a real
 * shortage.
 */
export async function getStockAlerts(options?: {
  severity?: StockSeverity;
  deadOnly?: boolean;
  page?: number;
  pageSize?: number;
  scope?: BranchScope;
}): Promise<StockAlertResult> {
  await connectDB();

  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 50;
  const now = new Date();

  const [medicines, stockRows, salesByMedicine, lastSaleByMedicine] =
    await Promise.all([
      Medicine.find({ isActive: { $ne: false }, ...pharmacyMatch(options?.scope) })
        .select("name genericName unit category reorderLevel createdAt")
        .lean(),
      Batch.aggregate([
        {
          $match: {
            quantity: { $gt: 0 },
            expiryDate: { $gte: now },
            ...branchFilter(options?.scope),
          },
        },
        {
          $group: {
            _id: "$medicineId",
            quantity: { $sum: "$quantity" },
            value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
            firstReceived: { $min: "$createdAt" },
          },
        },
      ]),
      getUnitsSoldByMedicine(addDays(now, -SALES_WINDOW_DAYS), now, options?.scope),
      getLastSaleByMedicine(options?.scope),
    ]);

  const stockById = new Map(
    (
      stockRows as Array<{
        _id: unknown;
        quantity: number;
        value: number;
        firstReceived?: Date;
      }>
    ).map((row) => [String(row._id), row]),
  );

  const dayMs = 86_400_000;

  const rows: StockAlert[] = medicines.map((medicine) => {
    const id = String(medicine._id);
    const stock = stockById.get(id);
    const stockQuantity = stock?.quantity ?? 0;

    const rate = averageDailySales(
      salesByMedicine.get(id) ?? 0,
      SALES_WINDOW_DAYS,
    );

    const lastSoldAt = lastSaleByMedicine.get(id) ?? null;
    const daysSinceLastSale = lastSoldAt
      ? Math.floor((now.getTime() - lastSoldAt.getTime()) / dayMs)
      : null;

    const receivedAt = stock?.firstReceived
      ? new Date(stock.firstReceived)
      : new Date(medicine.createdAt as unknown as Date);
    const daysSinceReceived = Math.floor(
      (now.getTime() - receivedAt.getTime()) / dayMs,
    );

    return {
      medicineId: id,
      medicineName: medicine.name,
      genericName: medicine.genericName ?? "",
      unit: medicine.unit ?? "unit",
      category: medicine.category ?? "Other",
      stockQuantity,
      reorderLevel: medicine.reorderLevel ?? config.lowStockThreshold,
      salesRate: rate,
      assessment: assessStock({
        stockQuantity,
        averageDailySales: rate,
        reorderLevel: medicine.reorderLevel ?? config.lowStockThreshold,
      }),
      daysSinceLastSale,
      // Only stock actually sitting there can be dead.
      isDead:
        stockQuantity > 0 &&
        isDeadStock({ daysSinceLastSale, daysSinceReceived }),
      stockValue: Math.round((stock?.value ?? 0) * 100) / 100,
    };
  });

  const counts = {
    out: 0,
    critical: 0,
    low: 0,
    ok: 0,
    overstocked: 0,
  } as Record<StockSeverity, number>;
  for (const row of rows) counts[row.assessment.severity] += 1;

  const dead = rows.filter((row) => row.isDead);

  let filtered = rows;
  if (options?.deadOnly) filtered = dead;
  else if (options?.severity) {
    filtered = rows.filter((row) => row.assessment.severity === options.severity);
  }

  filtered = [...filtered].sort(
    (a, b) =>
      stockRank(a.assessment.severity) - stockRank(b.assessment.severity) ||
      (a.assessment.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
        (b.assessment.daysOfCover ?? Number.MAX_SAFE_INTEGER) ||
      a.medicineName.localeCompare(b.medicineName),
  );

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    counts,
    deadStockCount: dead.length,
    deadStockValue:
      Math.round(dead.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100,
  };
}

export interface AlertOverview {
  expiry: {
    expired: number;
    critical: number;
    warning: number;
    valueAtRisk: number;
  };
  stock: {
    out: number;
    critical: number;
    low: number;
    overstocked: number;
  };
  deadStock: { count: number; value: number };
  /** Everything that wants attention today. */
  actionableCount: number;
}

/** One roll-up for the dashboard and the nav badge. */
export async function getAlertOverview(scope?: BranchScope): Promise<AlertOverview> {
  return onceTtl(`alert-overview:${scopeCacheKey(scope)}`, 15_000, async () => {
  const [expiry, stock] = await Promise.all([
    getExpiryAlerts({ pageSize: 1, scope }),
    getStockAlerts({ pageSize: 1, scope }),
  ]);

  return {
    expiry: {
      expired: expiry.counts.expired,
      critical: expiry.counts.critical,
      warning: expiry.counts.warning,
      valueAtRisk: expiry.totalValueAtRisk,
    },
    stock: {
      out: stock.counts.out,
      critical: stock.counts.critical,
      low: stock.counts.low,
      overstocked: stock.counts.overstocked,
    },
    deadStock: { count: stock.deadStockCount, value: stock.deadStockValue },
    // What a pharmacist should genuinely act on before opening.
    actionableCount:
      expiry.counts.expired +
      expiry.counts.critical +
      stock.counts.out +
      stock.counts.critical,
  };
  });
}
