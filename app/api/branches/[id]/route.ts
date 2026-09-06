import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchActivity, updateBranch } from "@/lib/branches";
import { connectDB } from "@/lib/db";
import { Branch } from "@/models/Branch";
import { branchSchema, objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function branchId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/branches/:id */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("branch:manage");
  const id = await branchId(ctx);
  await connectDB();

  const branch = await Branch.findOne({
    _id: id,
    ...(user.pharmacyId ? { pharmacyId: user.pharmacyId } : {}),
  }).lean();
  if (!branch) throw ApiError.notFound("That branch no longer exists.");

  const activity = await branchActivity(id, user.pharmacyId);
  return ok({
    id: String(branch._id),
    code: branch.code,
    name: branch.name,
    address: branch.address ?? "",
    phone: branch.phone ?? "",
    panNo: branch.panNo ?? "",
    isDefault: Boolean(branch.isDefault),
    isActive: branch.isActive !== false,
    notes: branch.notes ?? "",
    ...activity,
  });
});

/** PATCH /api/branches/:id */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("branch:manage");
  const id = await branchId(ctx);
  const input = await parseJson(req, branchSchema);
  const branch = await updateBranch(user, id, input);
  return ok(branch);
});
