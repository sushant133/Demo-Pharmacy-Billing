import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { xlsxToCsv } from "@/lib/medicine-import-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Larger than any real catalogue workbook; refuses a mistaken upload early. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/medicines/import/excel - read an .xlsx into import text.
 *
 * The body is the raw workbook. Nothing is written and nothing is validated
 * here: the reply is the CSV the import panel shows and then sends to
 * /api/medicines/import, so Excel rows go through the same preview and the
 * same checks as a pasted or CSV file.
 */
export const POST = withRoute(async (req) => {
  await requirePermission("medicine:write");

  const data = await req.arrayBuffer();
  if (data.byteLength === 0) throw ApiError.badRequest("That file is empty.");
  if (data.byteLength > MAX_BYTES) {
    throw ApiError.badRequest("That workbook is too large to import in one go.");
  }

  try {
    return ok(await xlsxToCsv(data));
  } catch (error) {
    throw ApiError.badRequest(
      error instanceof Error ? error.message : "That workbook could not be read.",
    );
  }
});
