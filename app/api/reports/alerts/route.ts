import { ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getAlertOverview, getExpiryAlerts, getStockAlerts } from "@/lib/alerts";
import { resolveRequestScope, resolveViewScope } from "@/lib/branch-scope";
import {
  EXPIRY_SEVERITIES,
  STOCK_SEVERITIES,
  type ExpirySeverity,
  type StockSeverity,
} from "@/lib/alert-rules";
import { alertQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/alerts?kind=expiry|stock|dead&severity=&withinDays=
 *
 * The refined replacement for Phase 1's flat low-stock and expiring-soon
 * lists: rows come back graded, sorted worst-first, and carry the sales rate
 * that justifies the grade.
 *
 * Only `report:read`: what is expiring is counter knowledge, not a figure.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("report:read");
  const { kind, severity, withinDays, page, pageSize } = parseQuery(
    req,
    alertQuerySchema,
  );
  const scope = await resolveRequestScope(user, req);

  if (kind === "expiry") {
    const valid = (EXPIRY_SEVERITIES as readonly string[]).includes(severity ?? "");
    const result = await getExpiryAlerts({
      withinDays,
      severity: valid ? (severity as ExpirySeverity) : undefined,
      page,
      pageSize,
      scope,
    });

    return ok(result.rows, {
      page,
      pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
      counts: result.counts,
      valueAtRisk: result.totalValueAtRisk,
    });
  }

  const valid = (STOCK_SEVERITIES as readonly string[]).includes(severity ?? "");
  const result = await getStockAlerts({
    severity: valid ? (severity as StockSeverity) : undefined,
    deadOnly: kind === "dead",
    page,
    pageSize,
    scope,
  });

  return ok(result.rows, {
    page,
    pageSize,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    counts: result.counts,
    deadStockCount: result.deadStockCount,
    deadStockValue: result.deadStockValue,
  });
});

/** HEAD is used by the nav badge; it only needs the roll-up counts. */
export const POST = withRoute(async () => {
  const user = await requirePermission("report:read");
  const scope = await resolveViewScope(user);
  return ok(await getAlertOverview(scope));
});
