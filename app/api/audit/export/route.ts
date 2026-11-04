import { ApiError, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { auditLogReport, isAuditAction } from "@/lib/audit-view";
import { dateRangeFromStrings, localDayRange } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { datasetResponse, type ExportFormat } from "@/lib/export/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS: readonly ExportFormat[] = ["csv", "xlsx", "pdf"];

/**
 * GET /api/audit/export?format=pdf&from=&to=&user=&action=&entity=&q=
 *
 * The audit trail as a file, with the same filters as the screen, so what an
 * auditor prints is exactly what they were looking at.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("audit:read");
  const params = new URL(req.url).searchParams;

  const format = (params.get("format") ?? "pdf") as ExportFormat;
  if (!FORMATS.includes(format)) throw ApiError.badRequest("Unknown format.");

  const range = dateRangeFromStrings(params.get("from") ?? "", params.get("to") ?? "");
  const today = localDayRange();
  const start = range.start ?? today.start;
  const end = range.end ?? today.end;
  if (start.getTime() >= end.getTime()) {
    throw ApiError.badRequest("The start date must be before the end date.");
  }

  const action = params.get("action");
  const dataset = await auditLogReport(user, {
    start,
    end,
    rangeLabel: `${formatDate(start)} to ${formatDate(new Date(end.getTime() - 1))}`,
    actorId: params.get("user") || null,
    action: isAuditAction(action) ? action : null,
    entity: params.get("entity") || null,
    search: params.get("q") || null,
  });

  return datasetResponse(dataset, format, user);
});
