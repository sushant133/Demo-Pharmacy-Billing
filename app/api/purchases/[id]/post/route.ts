import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { postPurchase } from "@/lib/purchases";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/purchases/:id/post
 *
 * The moment stock becomes real: creates a Batch per line (or tops up an
 * existing lot of the same batch number), inside one transaction.
 */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("purchase:post");
  const { id } = await ctx.params;

  const result = await postPurchase(objectIdSchema.parse(id), user);
  return ok(result);
});
