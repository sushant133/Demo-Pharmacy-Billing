import { ApiError, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resolveRequestScope } from "@/lib/branch-scope";
import { dateRangeFromStrings, localDayRange } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { datasetResponse } from "@/lib/export/respond";
import { DATED_REPORTS, buildReport, isReportKey } from "@/lib/export/reports";
import { exportQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/export?report=&format=csv|xlsx|pdf&from=&to=
 *
 * One route for every report and every format: the report builder produces a
 * neutral dataset and the renderer turns it into bytes, so neither side knows
 * about the other.
 *
 * Financial reports (anything exposing cost or margin) additionally require
 * `report:financial`, so the split survives if a limited role is ever added.
 */

/** Reports that reveal cost price, margin or supplier liabilities. */
const FINANCIAL_REPORTS = new Set([
  "sales-register",
  "sales-detail",
  "profit-by-medicine",
  "stock-valuation",
  // Carries unit cost and value per movement.
  "stock-movements",
  "purchase-register",
  "payables",
  // What the shop paid its suppliers, and the tax position built from it.
  "purchase-book",
  "debit-note-book",
  "parties-above-lakh",
  "vat-return",
  "materialized-view",
]);

export const GET = withRoute(async (req) => {
  const user = await requirePermission("report:export");

  const { report, format, from, to, direction } = parseQuery(req, exportQuerySchema);

  if (!isReportKey(report)) {
    throw ApiError.badRequest(`Unknown report "${report}".`);
  }

  if (FINANCIAL_REPORTS.has(report)) {
    await requirePermission("report:financial");
  }

  // Undated reports are point-in-time, so their range is cosmetic.
  const range = dateRangeFromStrings(from, to);
  const today = localDayRange();
  const start = range.start ?? today.start;
  const end = range.end ?? today.end;

  if (start.getTime() >= end.getTime()) {
    throw ApiError.badRequest("The start date must be before the end date.");
  }

  const rangeLabel = DATED_REPORTS.has(report)
    ? // `end` is exclusive, so step back a day for a human-readable label.
      `${formatDate(start)} to ${formatDate(new Date(end.getTime() - 1))}`
    : `As at ${formatDate(new Date())}`;

  const scope = await resolveRequestScope(user, req);
  const dataset = await buildReport(report, {
    from: start,
    to: end,
    rangeLabel,
    scope,
    direction,
  });
  return datasetResponse(dataset, format, user);
});
