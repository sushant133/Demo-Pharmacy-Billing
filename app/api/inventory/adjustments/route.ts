import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { adjustStock } from "@/lib/stock-movements";
import { adjustStockSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/adjustments - correct a lot's count.
 *
 * Takes the counted figure, not a delta, and records the difference as an
 * append-only movement. Nothing here edits a balance without leaving a reason
 * and an author behind it.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("batch:write");
  const input = await parseJson(req, adjustStockSchema);

  return created(await adjustStock(user, input));
});
