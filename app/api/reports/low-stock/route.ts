import { ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resolveRequestScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { getLowStock } from "@/lib/reports";
import { lowStockQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/low-stock?threshold=&page=&pageSize=
 *
 * A medicine is low when its sellable stock (in-stock and unexpired, summed
 * across batches) is below its own reorderLevel, or below `threshold` when it
 * has none set.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("report:read");
  const { threshold, page, pageSize } = parseQuery(req, lowStockQuerySchema);
  const scope = await resolveRequestScope(user, req);

  const { rows, total } = await getLowStock({ threshold, page, pageSize, scope });

  return ok(rows, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    defaultThreshold: threshold ?? config.lowStockThreshold,
  });
});
