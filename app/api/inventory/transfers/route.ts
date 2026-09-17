import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { transferStock } from "@/lib/stock-movements";
import { transferStockSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/transfers - move units of a lot to another branch.
 *
 * Two movements and two lots, not a field change: a lot belongs to one branch,
 * which is what keeps two outlets' stock separate rather than one pooled pile.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("batch:write");
  const input = await parseJson(req, transferStockSchema);

  return created(await transferStock(user, input));
});
