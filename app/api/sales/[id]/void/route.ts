import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { voidSale } from "@/lib/sales";
import { objectIdSchema, voidSaleSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/:id/void - requires `sale:void`.
 *
 * Returns the bill's units to the batches they were dispensed from and drops
 * the bill out of every financial figure. The bill itself stays on record.
 *
 * Takes the Mongo id only, not the printed bill number: GET accepts either so
 * counter staff can look a bill up from the customer's copy, but a mutation
 * this consequential should be aimed at something unambiguous.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("sale:void");
  const { id } = await ctx.params;
  const { reason } = await parseJson(req, voidSaleSchema);

  const result = await voidSale(objectIdSchema.parse(id), reason, user);
  return ok(result);
});
