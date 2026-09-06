import { Types } from "mongoose";
import { ApiError, ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchFilter, resolveRequestScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { addDays } from "@/lib/dates";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { pharmacyFilter } from "@/lib/tenant";
import { batchQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/batches
 * Query: medicineId, q, status=all|in-stock|expired|expiring, page, pageSize
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("batch:read");
  const { medicineId, q, status, page, pageSize } = parseQuery(req, batchQuerySchema);
  await connectDB();

  const now = new Date();
  const scope = await resolveRequestScope(user, req);
  const filter: Record<string, unknown> = {
    ...pharmacyFilter(user),
    ...branchFilter(scope),
  };

  if (medicineId) filter.medicineId = new Types.ObjectId(medicineId);

  if (status === "in-stock") {
    filter.quantity = { $gt: 0 };
    filter.expiryDate = { $gte: now };
  } else if (status === "expired") {
    filter.expiryDate = { $lt: now };
  } else if (status === "expiring") {
    filter.quantity = { $gt: 0 };
    filter.expiryDate = { $gte: now, $lte: addDays(now, config.expiryAlertDays) };
  }

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match the lot number directly, or any medicine whose name matches.
    const matchingMedicines = await Medicine.find({
      ...pharmacyFilter(user),
      $or: [
        { name: new RegExp(safe, "i") },
        { genericName: new RegExp(safe, "i") },
      ],
    })
      .select("_id")
      .lean();

    filter.$or = [
      { batchNumber: new RegExp(safe, "i") },
      { medicineId: { $in: matchingMedicines.map((m) => m._id) } },
    ];
  }

  const [docs, total] = await Promise.all([
    Batch.find(filter)
      .sort({ expiryDate: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("medicineId", "name unit genericName")
      .lean(),
    Batch.countDocuments(filter),
  ]);

  const data = docs.map((batch) => {
    const medicine = batch.medicineId as unknown as {
      _id: Types.ObjectId;
      name?: string;
      unit?: string;
      genericName?: string;
    } | null;
    const expiry = new Date(batch.expiryDate);

    return {
      id: String(batch._id),
      medicineId: medicine ? String(medicine._id) : "",
      medicineName: medicine?.name ?? "Unknown medicine",
      genericName: medicine?.genericName ?? "",
      unit: medicine?.unit ?? "unit",
      batchNumber: batch.batchNumber,
      mfgDate: batch.mfgDate,
      expiryDate: batch.expiryDate,
      quantity: batch.quantity,
      initialQuantity: batch.initialQuantity,
      costPrice: batch.costPrice,
      salePrice: batch.salePrice,
      supplierId: batch.supplierId ? String(batch.supplierId) : null,
      grnId: batch.grnId ? String(batch.grnId) : null,
      grnNo: batch.grnNo ?? "",
      notes: batch.notes ?? "",
      expired: expiry < now,
      daysRemaining: Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000),
      stockValue: Math.round(batch.quantity * batch.costPrice * 100) / 100,
      createdAt: batch.createdAt,
    };
  });

  return ok(data, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/**
 * POST /api/batches - removed in Phase 2.
 *
 * Stock now enters the shop only by posting a purchase, so that every unit on
 * a shelf is traceable to the supplier delivery it arrived on. Kept as an
 * explicit, explanatory 409 rather than a bare 405 so any older client gets
 * told where the flow moved to.
 */
export const POST = withRoute(async () => {
  throw ApiError.conflict(
    "Batches can no longer be created directly. Record a purchase (GRN) instead - posting it creates the batch and links it to the supplier. See POST /api/purchases.",
  );
});
