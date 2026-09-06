import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { closeBranch } from "@/lib/branches";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/branches/:id/close - deactivate an empty outlet. */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("branch:manage");
  const { id } = await ctx.params;
  const result = await closeBranch(user, objectIdSchema.parse(id));
  return ok(result);
});
