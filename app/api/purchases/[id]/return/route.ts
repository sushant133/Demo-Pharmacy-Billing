import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { returnPurchaseItems } from "@/lib/purchases";
import { purchaseReturnSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/purchases/:id/return - send goods back to the supplier.
 *
 * Guarded by `purchase:post` rather than `purchase:write`. Writing a draft
 * changes nothing real; this takes units off the shelf and reduces what the
 * shop owes, which is the same weight of act as posting a delivery and belongs
 * with whoever is trusted to do that. An inventory clerk holds it; a cashier
 * does not.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("purchase:post");
  const { id } = await ctx.params;
  const input = await parseJson(req, purchaseReturnSchema);

  return ok(await returnPurchaseItems(id, input, user));
});
