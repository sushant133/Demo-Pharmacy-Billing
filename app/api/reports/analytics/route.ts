import { ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resolveRequestScope } from "@/lib/branch-scope";
import { dateRangeFromStrings, localDayRange } from "@/lib/dates";
import {
  getMedicinePerformance,
  getPaymentMix,
  getProfitSummary,
  getPurchaseVsSales,
  getSalesSeries,
  granularityFor,
} from "@/lib/analytics";
import { analyticsQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/analytics?from=&to=&granularity=&by=&limit=
 *
 * Everything the sales/profit dashboard needs, in one round of parallel
 * queries. Requires `report:financial` - the payload exposes cost and margin.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("report:financial");
  const { from, to, granularity, by, limit } = parseQuery(req, analyticsQuerySchema);
  const scope = await resolveRequestScope(user, req);

  const range = dateRangeFromStrings(from, to);
  const today = localDayRange();
  const start = range.start ?? today.start;
  const end = range.end ?? today.end;

  const bucket = granularity ?? granularityFor(start, end);

  const [summary, series, topMedicines, paymentMix, stockFlow] = await Promise.all([
    getProfitSummary(start, end, scope),
    getSalesSeries(start, end, bucket, scope),
    getMedicinePerformance(start, end, { limit, by, scope }),
    getPaymentMix(start, end, scope),
    getPurchaseVsSales(start, end, scope),
  ]);

  return ok({
    range: { from: start.toISOString(), to: end.toISOString(), granularity: bucket },
    summary,
    series,
    topMedicines,
    paymentMix,
    stockFlow,
  });
});
