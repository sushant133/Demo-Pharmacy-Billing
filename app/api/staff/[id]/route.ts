import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { removeStaff, updateStaff } from "@/lib/staff";
import { staffUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/staff/:id - edit a colleague's name, email or home branch. */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("user:manage");
  const { id } = await ctx.params;
  const input = await parseJson(req, staffUpdateSchema);

  return ok(await updateStaff(user, id, input));
});

/**
 * DELETE /api/staff/:id - remove an account.
 *
 * Only ever a real delete for a login that was issued and never used. Once
 * somebody has billed or received stock their name is on those records, so the
 * account is disabled instead and the response says which happened.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("user:manage");
  const { id } = await ctx.params;

  return ok(await removeStaff(user, id));
});
