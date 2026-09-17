import { Types } from "mongoose";
import { branchForWrite } from "@/lib/branches";
import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB, withDbWrite } from "@/lib/db";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { pharmacyFilter } from "@/lib/tenant";
import { resolveUnitsPerStrip } from "@/lib/pack";
import { medicineQuerySchema, medicineSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/medicines
 * Query: q, category, page, pageSize, withStock=0|1
 *
 * `q` matches brand name, generic name and salt composition, so a customer
 * asking for "Cetirizine" finds every brand that contains it.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("medicine:read");
  const { q, category, page, pageSize, withStock } = parseQuery(
    req,
    medicineQuerySchema,
  );
  await connectDB();

  const filter: Record<string, unknown> = { ...pharmacyFilter(user) };
  // POS search must not offer discontinued lines: the till will refuse them
  // at checkout, which is too late once they are already in the cart.
  if (withStock === "1") filter.isActive = { $ne: false };
  if (category) filter.category = category;
  if (q) {
    // Regex rather than $text: it matches mid-word, which is what staff expect
    // when they type three letters into the POS search box.
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { name: pattern },
      { genericName: pattern },
      { saltComposition: pattern },
      { manufacturer: pattern },
      // A scanned code is an exact string, not a fragment of a name: matching
      // it loosely would let "500" from a barcode pull up every 500mg line.
      { barcode: q },
      // The shop's own code, matched exactly and case-insensitively for the
      // same reason. Stored upper-cased, so the typed form is raised to match.
      { sku: q.toUpperCase() },
    ];
  }

  const [docs, total] = await Promise.all([
    Medicine.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Medicine.countDocuments(filter),
  ]);

  let stockByMedicine = new Map<string, { quantity: number; nearestExpiry: Date | null }>();

  if (withStock === "1" && docs.length > 0) {
    const now = new Date();
    // POS search must match the till, not the report view: "all branches"
    // would show stock that FEFO will not actually dispense.
    const write = await branchForWrite(user);
    const rows = await Batch.aggregate<{
      _id: Types.ObjectId;
      quantity: number;
      nearestExpiry: Date | null;
    }>([
      {
        $match: {
          ...pharmacyFilter(user),
          medicineId: { $in: docs.map((doc) => doc._id) },
          quantity: { $gt: 0 },
          expiryDate: { $gte: now },
          branchId: write.id,
        },
      },
      {
        $group: {
          _id: "$medicineId",
          quantity: { $sum: "$quantity" },
          nearestExpiry: { $min: "$expiryDate" },
        },
      },
    ]);
    stockByMedicine = new Map(
      rows.map((row) => [
        String(row._id),
        { quantity: row.quantity, nearestExpiry: row.nearestExpiry },
      ]),
    );
  }

  const data = docs.map((doc) => {
    const stock = stockByMedicine.get(String(doc._id));
    return {
      id: String(doc._id),
      sku: doc.sku ?? "",
      name: doc.name,
      genericName: doc.genericName ?? "",
      saltComposition: doc.saltComposition ?? "",
      manufacturer: doc.manufacturer ?? "",
      category: doc.category ?? "Other",
      unit: doc.unit ?? "tablet",
      packSize: doc.packSize ?? "",
      barcode: doc.barcode ?? "",
      unitsPerStrip: resolveUnitsPerStrip(
        doc.unit ?? "tablet",
        doc.packSize ?? "",
        doc.unitsPerStrip,
      ),
      requiresPrescription: Boolean(doc.requiresPrescription),
      reorderLevel: doc.reorderLevel ?? null,
      isActive: doc.isActive !== false,
      createdAt: doc.createdAt,
      ...(withStock === "1"
        ? {
            stockQuantity: stock?.quantity ?? 0,
            nearestExpiry: stock?.nearestExpiry ?? null,
          }
        : {}),
    };
  });

  return ok(data, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/** POST /api/medicines - add a medicine to the catalogue. */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("medicine:write");
  const input = await parseJson(req, medicineSchema);

  const medicine = await withDbWrite(() =>
    Medicine.create({ ...input, ...pharmacyFilter(user) }),
  );
  return created({
    id: String(medicine._id),
    sku: medicine.sku ?? "",
    name: medicine.name,
    genericName: medicine.genericName ?? "",
    saltComposition: medicine.saltComposition ?? "",
    manufacturer: medicine.manufacturer ?? "",
    category: medicine.category ?? "Other",
    unit: medicine.unit ?? "tablet",
    packSize: medicine.packSize ?? "",
    barcode: medicine.barcode ?? "",
    requiresPrescription: Boolean(medicine.requiresPrescription),
    reorderLevel: medicine.reorderLevel ?? null,
    isActive: medicine.isActive !== false,
  });
});
