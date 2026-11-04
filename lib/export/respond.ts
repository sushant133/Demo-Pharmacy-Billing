import { formatDate } from "@/lib/format";
import { contentDisposition, filenameFor, type ReportDataset } from "@/lib/export/dataset";
import { toCsvBuffer } from "@/lib/export/csv";
import { XLSX_CONTENT_TYPE, toXlsxBuffer } from "@/lib/export/xlsx";
import { PDF_CONTENT_TYPE, toPdfBuffer } from "@/lib/export/pdf";
import { getSettings, issuerFor } from "@/lib/settings";
import type { SessionUser } from "@/lib/session";

export type ExportFormat = "csv" | "xlsx" | "pdf";

/** Render a dataset in the format asked for, as a download. */
export async function datasetResponse(
  dataset: ReportDataset,
  format: ExportFormat,
  user: SessionUser,
): Promise<Response> {
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
}
