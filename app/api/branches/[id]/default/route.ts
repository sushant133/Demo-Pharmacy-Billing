import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setDefaultBranch } from "@/lib/branches";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/branches/:id/default - make this the fallback outlet. */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("branch:manage");
  const { id } = await ctx.params;
  const result = await setDefaultBranch(objectIdSchema.parse(id));
  return ok(result);
});
