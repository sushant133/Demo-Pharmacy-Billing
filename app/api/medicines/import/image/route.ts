import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import {
  IMAGE_MEDIA_TYPES,
  ImageImportError,
  imageImportConfigured,
  readMedicineImage,
  type ImageMediaType,
} from "@/lib/medicine-image-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading a dense bill can take the better part of a minute.
export const maxDuration = 120;

/** The panel shrinks photos before sending; this only refuses a mistake. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/medicines/import/image - read a photo of a medicine list.
 *
 * The body is the raw image, its type in Content-Type. Nothing is written:
 * the reply is the CSV the import panel shows, so the rows go through the
 * same preview and the same checks as a pasted list or an Excel file.
 */
export const POST = withRoute(async (req) => {
  await requirePermission("medicine:write");

  if (!imageImportConfigured()) {
    throw ApiError.badRequest(
      "Reading medicines from a photo is not switched on for this server yet. Ask the administrator to add an ANTHROPIC_API_KEY.",
    );
  }

  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw ApiError.badRequest("Upload a JPG, PNG or WebP photo.");
  }

  const data = Buffer.from(await req.arrayBuffer());
  if (data.byteLength === 0) throw ApiError.badRequest("That photo is empty.");
  if (data.byteLength > MAX_BYTES) {
    throw ApiError.badRequest("That photo is too large. Use one under 5 MB.");
  }

  try {
    return ok(await readMedicineImage(data, mediaType as ImageMediaType));
  } catch (error) {
    if (error instanceof ImageImportError) throw ApiError.badRequest(error.message);
    throw error;
  }
});
