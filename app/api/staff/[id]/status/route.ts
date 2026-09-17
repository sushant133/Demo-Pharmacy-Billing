import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setStaffActive } from "@/lib/staff";
import { staffActiveSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/staff/:id/status - enable or disable an account.
 *
 * Refuses to disable the caller's own account or the last one that can still
 * sign in, so a shop cannot lock itself out of its own till.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("user:manage");
  const { id } = await ctx.params;
  const { isActive } = await parseJson(req, staffActiveSchema);

  return ok(await setStaffActive(user, id, isActive));
});
