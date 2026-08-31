import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { planSale } from "@/lib/sales";
import { quoteSaleSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sales/quote - dry-run a cart.
 *
 * Returns the exact batches FEFO would draw from and the resulting totals,
 * without touching stock. The POS calls this as the cart changes so the
 * cashier can see the batch and expiry before committing.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("sale:create");
  const input = await parseJson(req, quoteSaleSchema);
  const plan = await planSale(input, user);
  return ok(plan);
});
