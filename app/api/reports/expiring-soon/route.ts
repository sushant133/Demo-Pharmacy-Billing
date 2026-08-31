import { ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resolveRequestScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { getExpiringSoon } from "@/lib/reports";
import { expiringQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/expiring-soon?days=&includeExpired=0|1
 *
 * Batches with stock whose expiry falls inside the next `days` days, soonest
 * first. `valueAtRisk` is the money tied up in that stock at cost - the number
 * that decides whether a return-to-supplier is worth chasing.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("report:read");
  const { days, includeExpired, page, pageSize } = parseQuery(
    req,
    expiringQuerySchema,
  );
  const scope = await resolveRequestScope(user, req);

  const { rows, total, valueAtRisk } = await getExpiringSoon({
    days,
    includeExpired: includeExpired === "1",
    page,
    pageSize,
    scope,
  });

  return ok(rows, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    days: days ?? config.expiryAlertDays,
    valueAtRisk,
  });
});
