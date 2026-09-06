import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { returnSaleItems } from "@/lib/sales";
import { objectIdSchema, returnSaleSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/:id/return - requires `sale:void`.
 *
 * Puts selected units back on the lots they were dispensed from. The bill
 * stays; the return is recorded on it so the sales register can show it.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("sale:void");
  const { id } = await ctx.params;
  const input = await parseJson(req, returnSaleSchema);

  const result = await returnSaleItems(objectIdSchema.parse(id), input, user);
  return ok(result);
});
