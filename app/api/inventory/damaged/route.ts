import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { writeOffStock } from "@/lib/stock-movements";
import { writeOffStockSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/damaged - take units off the shelf for good.
 *
 * Separate from an adjustment because the two mean different things to anyone
 * reading the books later: an adjustment says the count was wrong, a write-off
 * says the count was right and the stock is gone.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("batch:write");
  const input = await parseJson(req, writeOffStockSchema);

  return created(await writeOffStock(user, input));
});
