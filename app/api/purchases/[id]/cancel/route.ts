import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { cancelPurchase } from "@/lib/purchases";
import { cancelPurchaseSchema, objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/purchases/:id/cancel - admin only.
 *
 * Reverses the stock a posted GRN created. Refused once any of it has been
 * sold, since unwinding those units would leave the sale records inconsistent.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("purchase:cancel");
  const { id } = await ctx.params;
  const { reason } = await parseJson(req, cancelPurchaseSchema);

  const result = await cancelPurchase(objectIdSchema.parse(id), reason, user);
  return ok(result);
});
