import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { Batch } from "@/models/Batch";
import { Sale } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { batchUpdateSchema, objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function batchId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/batches/:id */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("batch:read");
  const id = await batchId(ctx);
  await connectDB();
  const scope = await resolveViewScope(user);

  const batch = await Batch.findOne({ _id: id, ...pharmacyFilter(user) })
    .populate("medicineId", "name unit")
    .lean();
  if (!batch) throw ApiError.notFound("That batch no longer exists.");
  assertVisibleInScope(batch.branchId, scope, "That batch no longer exists.");

  return ok({ id: String(batch._id), ...batch });
});

/**
 * PATCH /api/batches/:id
 *
 * Quantity edits here are stock corrections (damage, recount, expiry
 * write-off), so the new value is set outright rather than incremented.
 */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("batch:write");
  const id = await batchId(ctx);
  const update = await parseJson(req, batchUpdateSchema);
  await connectDB();
  const scope = await resolveViewScope(user);

  const existing = await Batch.findOne({ _id: id, ...pharmacyFilter(user) })
    .select("branchId")
    .lean();
  if (!existing) throw ApiError.notFound("That batch no longer exists.");
  assertVisibleInScope(existing.branchId, scope, "That batch no longer exists.");

  const batch = await Batch.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    update,
    {
    new: true,
    runValidators: true,
  }).lean();
  if (!batch) throw ApiError.notFound("That batch no longer exists.");

  return ok({ id: String(batch._id), ...batch });
});

/**
 * DELETE /api/batches/:id - requires `batch:delete`.
 *
 * Refused once the batch appears on a bill: deleting it would make those bills
 * unreprintable and silently rewrite sales history. Zero the quantity instead.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("batch:delete");
  const id = await batchId(ctx);
  await connectDB();
  const scope = await resolveViewScope(user);

  const batch = await Batch.findOne({ _id: id, ...pharmacyFilter(user) });
  if (!batch) throw ApiError.notFound("That batch no longer exists.");
  assertVisibleInScope(batch.branchId, scope, "That batch no longer exists.");

  const soldCount = await Sale.countDocuments({ "items.batchId": batch._id });
  if (soldCount > 0) {
    throw ApiError.conflict(
      `Batch ${batch.batchNumber} appears on ${soldCount} bill(s) and cannot be deleted. Set its quantity to 0 instead to take it off the shelf.`,
    );
  }

  await batch.deleteOne();
  return ok({ id, deleted: true, message: `Batch ${batch.batchNumber} was deleted.` });
});
