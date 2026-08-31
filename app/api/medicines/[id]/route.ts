import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { medicineUpdateSchema, objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function medicineId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/medicines/:id - one medicine plus a live stock summary. */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("medicine:read");
  const id = await medicineId(ctx);
  await connectDB();
  const scope = await resolveViewScope(user);

  const medicine = await Medicine.findById(id).lean();
  if (!medicine) throw ApiError.notFound("That medicine no longer exists.");

  const now = new Date();
  const batches = await Batch.find({ medicineId: id, ...branchFilter(scope) })
    .sort({ expiryDate: 1 })
    .lean();

  const sellable = batches.filter(
    (batch) => batch.quantity > 0 && new Date(batch.expiryDate) >= now,
  );

  return ok({
    id: String(medicine._id),
    ...medicine,
    stockQuantity: sellable.reduce((sum, batch) => sum + batch.quantity, 0),
    batches: batches.map((batch) => ({
      id: String(batch._id),
      batchNumber: batch.batchNumber,
      quantity: batch.quantity,
      costPrice: batch.costPrice,
      salePrice: batch.salePrice,
      expiryDate: batch.expiryDate,
      expired: new Date(batch.expiryDate) < now,
    })),
  });
});

/** PATCH /api/medicines/:id - edit catalogue details. */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  await requirePermission("medicine:write");
  const id = await medicineId(ctx);
  const update = await parseJson(req, medicineUpdateSchema);
  await connectDB();

  const medicine = await Medicine.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  }).lean();
  if (!medicine) throw ApiError.notFound("That medicine no longer exists.");

  return ok({ id: String(medicine._id), ...medicine });
});

/**
 * DELETE /api/medicines/:id - requires `medicine:delete`.
 *
 * A medicine that still has stock, or that appears on past bills, is
 * deactivated rather than deleted: removing it would orphan batch records and
 * break historical bill reprints. Only a never-stocked entry is hard-deleted.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("medicine:delete");
  const id = await medicineId(ctx);
  await connectDB();

  const medicine = await Medicine.findById(id);
  if (!medicine) throw ApiError.notFound("That medicine no longer exists.");

  const batchCount = await Batch.countDocuments({ medicineId: id });

  if (batchCount > 0) {
    medicine.isActive = false;
    await medicine.save();
    return ok({
      id,
      deleted: false,
      deactivated: true,
      message: `${medicine.name} has ${batchCount} batch record(s), so it was marked inactive instead of deleted. It will no longer appear in billing.`,
    });
  }

  await medicine.deleteOne();
  return ok({ id, deleted: true, deactivated: false, message: `${medicine.name} was deleted.` });
});
