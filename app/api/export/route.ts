import { ApiError, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resolveRequestScope } from "@/lib/branch-scope";
import { dateRangeFromStrings, localDayRange } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { contentDisposition, filenameFor } from "@/lib/export/dataset";
import { toCsvBuffer } from "@/lib/export/csv";
import { XLSX_CONTENT_TYPE, toXlsxBuffer } from "@/lib/export/xlsx";
import { PDF_CONTENT_TYPE, toPdfBuffer } from "@/lib/export/pdf";
import { getSettings, issuerFor } from "@/lib/settings";
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
  const settings = await getSettings(user.pharmacyId, user.pharmacyName);
  const shopName = settings.businessName.trim() || user.pharmacyName.trim();

  const { body, contentType, extension } =
    format === "csv"
      ? {
          body: toCsvBuffer(dataset, { formatDate: (d: Date) => formatDate(d) }),
          contentType: "text/csv; charset=utf-8",
          extension: "csv",
        }
      : format === "pdf"
        ? {
            body: await toPdfBuffer(dataset, {
              letterhead: issuerFor(settings),
            }),
            contentType: PDF_CONTENT_TYPE,
            extension: "pdf",
          }
        : {
            body: await toXlsxBuffer(dataset, { creator: shopName }),
            contentType: XLSX_CONTENT_TYPE,
            extension: "xlsx",
          };

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Content-Disposition": contentDisposition(filenameFor(dataset, extension)),
      // A report is a snapshot of live data; never let a proxy serve a stale one.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
});
