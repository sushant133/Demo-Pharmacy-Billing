import type { PipelineStage, Types } from "mongoose";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { pharmacyMatch } from "@/lib/tenant";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { addDays, localDayRange } from "@/lib/dates";
import { onceTtl, scopeCacheKey } from "@/lib/ttl-cache";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Sale } from "@/models/Sale";

/**
 * Read-side queries shared by the dashboard server components and the report
 * route handlers, so a number shown on a screen and the same number fetched
 * over the API can never disagree.
 */

export interface LowStockRow {
  medicineId: string;
  name: string;
  genericName: string;
  unit: string;
  category: string;
  /** Sellable units: in-stock and not expired. */
  totalQuantity: number;
  threshold: number;
  batchCount: number;
  /** Earliest expiry among sellable batches, if any stock remains. */
  nearestExpiry: string | null;
}

/**
 * Medicines whose sellable stock has fallen below their reorder level.
 *
 * Expired lots are excluded from the total on purpose: stock you cannot
 * legally sell is not stock, and counting it would hide a genuine shortage.
 */
export async function getLowStock(options?: {
  threshold?: number;
  page?: number;
  pageSize?: number;
  scope?: BranchScope;
}): Promise<{ rows: LowStockRow[]; total: number }> {
  await connectDB();

  const fallbackThreshold = options?.threshold ?? config.lowStockThreshold;
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 50;
  const now = new Date();

  const pipeline: PipelineStage[] = [
    { $match: { isActive: { $ne: false }, ...pharmacyMatch(options?.scope) } },
    {
      $lookup: {
        from: Batch.collection.name,
        let: { medicineId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$medicineId", "$$medicineId"] },
              quantity: { $gt: 0 },
              expiryDate: { $gte: now },
              ...branchFilter(options?.scope),
            },
          },
          {
            $group: {
              _id: null,
              totalQuantity: { $sum: "$quantity" },
              batchCount: { $sum: 1 },
              nearestExpiry: { $min: "$expiryDate" },
            },
          },
        ],
        as: "stock",
      },
    },
    {
      $addFields: {
        totalQuantity: { $ifNull: [{ $first: "$stock.totalQuantity" }, 0] },
        batchCount: { $ifNull: [{ $first: "$stock.batchCount" }, 0] },
        nearestExpiry: { $first: "$stock.nearestExpiry" },
        effectiveThreshold: {
          // A per-medicine reorderLevel wins over the global default.
          $ifNull: ["$reorderLevel", fallbackThreshold],
        },
      },
    },
    { $match: { $expr: { $lt: ["$totalQuantity", "$effectiveThreshold"] } } },
    {
      $facet: {
        rows: [
          { $sort: { totalQuantity: 1, name: 1 } },
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          {
            $project: {
              name: 1,
              genericName: 1,
              unit: 1,
              category: 1,
              totalQuantity: 1,
              batchCount: 1,
              nearestExpiry: 1,
              effectiveThreshold: 1,
            },
          },
        ],
        count: [{ $count: "value" }],
      },
    },
  ];

  type Facet = {
    rows: Array<{
      _id: Types.ObjectId;
      name: string;
      genericName?: string;
      unit?: string;
      category?: string;
      totalQuantity: number;
      batchCount: number;
      nearestExpiry?: Date;
      effectiveThreshold: number;
    }>;
    count: Array<{ value: number }>;
  };

  const [facet] = (await Medicine.aggregate(pipeline)) as Facet[];

  return {
    rows: (facet?.rows ?? []).map((row) => ({
      medicineId: String(row._id),
      name: row.name,
      genericName: row.genericName ?? "",
      unit: row.unit ?? "unit",
      category: row.category ?? "Other",
      totalQuantity: row.totalQuantity,
      threshold: row.effectiveThreshold,
      batchCount: row.batchCount,
      nearestExpiry: row.nearestExpiry ? row.nearestExpiry.toISOString() : null,
    })),
    total: facet?.count[0]?.value ?? 0,
  };
}

export interface ExpiringRow {
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
  expired: boolean;
  /** Money still tied up in this lot, at cost. */
  stockValue: number;
}

/** Batches with stock expiring within `days`, soonest first. */
export async function getExpiringSoon(options?: {
  days?: number;
  includeExpired?: boolean;
  page?: number;
  pageSize?: number;
  scope?: BranchScope;
}): Promise<{ rows: ExpiringRow[]; total: number; valueAtRisk: number }> {
  await connectDB();

  const days = options?.days ?? config.expiryAlertDays;
  const includeExpired = options?.includeExpired ?? true;
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 50;

  const now = new Date();
  const cutoff = addDays(now, days);

  const match: Record<string, unknown> = {
    quantity: { $gt: 0 },
    expiryDate: includeExpired ? { $lte: cutoff } : { $gte: now, $lte: cutoff },
    ...branchFilter(options?.scope),
  };

  const [rows, total, valueAgg] = await Promise.all([
    Batch.find(match)
      .sort({ expiryDate: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate<{ medicineId: { _id: Types.ObjectId; name: string; unit?: string } }>(
        "medicineId",
        "name unit",
      )
      .lean(),
    Batch.countDocuments(match),
    Batch.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
        },
      },
    ]),
  ]);

  const dayMs = 86_400_000;

  return {
    rows: rows.map((batch) => {
      const expiry = new Date(batch.expiryDate);
      const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / dayMs);
      const medicine = batch.medicineId as unknown as {
        _id: Types.ObjectId;
        name?: string;
        unit?: string;
      } | null;

      return {
        batchId: String(batch._id),
        batchNumber: batch.batchNumber,
        medicineId: medicine ? String(medicine._id) : "",
        medicineName: medicine?.name ?? "Unknown medicine",
        unit: medicine?.unit ?? "unit",
        quantity: batch.quantity,
        costPrice: batch.costPrice,
        salePrice: batch.salePrice,
        expiryDate: expiry.toISOString(),
        daysRemaining,
        expired: expiry.getTime() < now.getTime(),
        stockValue: Math.round(batch.quantity * batch.costPrice * 100) / 100,
      };
    }),
    total,
    valueAtRisk:
      Math.round(((valueAgg[0] as { value?: number })?.value ?? 0) * 100) / 100,
  };
}

export interface DashboardSummary {
  today: {
    salesTotal: number;
    billCount: number;
    itemCount: number;
    averageBill: number;
  };
  lowStockCount: number;
  expiringSoonCount: number;
  expiredCount: number;
  expiryWindowDays: number;
  lowStockThreshold: number;
  inventoryValue: number;
  recentSales: Array<{
    id: string;
    billNo: string;
    customerName: string;
    totalAmount: number;
    paymentMode: string;
    itemCount: number;
    createdAt: string;
    soldByName: string;
  }>;
}

/** Everything the dashboard needs, in one round of parallel queries. */
export async function getDashboardSummary(
  scope?: BranchScope,
): Promise<DashboardSummary> {
  return onceTtl(`dashboard:${scopeCacheKey(scope)}`, 10_000, () => loadDashboardSummary(scope));
}

async function loadDashboardSummary(scope?: BranchScope): Promise<DashboardSummary> {
  await connectDB();

  const now = new Date();
  const { start, end } = localDayRange(now);
  const expiryCutoff = addDays(now, config.expiryAlertDays);
  const scoped = branchFilter(scope);

  const [todayAgg, lowStock, expiringCount, expiredCount, inventoryAgg, recent] =
    await Promise.all([
      Sale.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, voidedAt: null, ...scoped } },
        {
          $group: {
            _id: null,
            salesTotal: {
              $sum: {
                $subtract: [
                  "$totalAmount",
                  { $ifNull: ["$returnedTotal", 0] },
                ],
              },
            },
            billCount: { $sum: 1 },
            itemCount: {
              $sum: {
                $subtract: [
                  { $sum: "$items.quantity" },
                  { $ifNull: ["$returnedUnits", 0] },
                ],
              },
            },
          },
        },
      ]),
      getLowStock({ pageSize: 1, scope }),
      Batch.countDocuments({
        quantity: { $gt: 0 },
        expiryDate: { $gte: now, $lte: expiryCutoff },
        ...scoped,
      }),
      Batch.countDocuments({ quantity: { $gt: 0 }, expiryDate: { $lt: now }, ...scoped }),
      Batch.aggregate([
        { $match: { quantity: { $gt: 0 }, ...scoped } },
        {
          $group: {
            _id: null,
            value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
          },
        },
      ]),
      Sale.find({ voidedAt: null, ...scoped })
        .sort({ createdAt: -1 })
        .limit(8)
        .select("billNo customerName totalAmount paymentMode items createdAt soldByName")
        .lean(),
    ]);

  const todayStats = (todayAgg[0] ?? {}) as {
    salesTotal?: number;
    billCount?: number;
    itemCount?: number;
  };
  const salesTotal = Math.round((todayStats.salesTotal ?? 0) * 100) / 100;
  const billCount = todayStats.billCount ?? 0;

  return {
    today: {
      salesTotal,
      billCount,
      itemCount: todayStats.itemCount ?? 0,
      averageBill: billCount > 0 ? Math.round((salesTotal / billCount) * 100) / 100 : 0,
    },
    lowStockCount: lowStock.total,
    expiringSoonCount: expiringCount,
    expiredCount,
    expiryWindowDays: config.expiryAlertDays,
    lowStockThreshold: config.lowStockThreshold,
    inventoryValue:
      Math.round(((inventoryAgg[0] as { value?: number })?.value ?? 0) * 100) / 100,
    recentSales: recent.map((sale) => ({
      id: String(sale._id),
      billNo: sale.billNo,
      customerName: sale.customerName ?? "",
      totalAmount: sale.totalAmount,
      paymentMode: sale.paymentMode,
      itemCount: sale.items.reduce((sum, item) => sum + item.quantity, 0),
      createdAt: new Date(sale.createdAt as unknown as Date).toISOString(),
      soldByName: sale.soldByName ?? "",
    })),
  };
}
