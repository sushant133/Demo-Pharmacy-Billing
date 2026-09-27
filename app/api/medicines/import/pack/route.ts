import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import {
  IMAGE_MEDIA_TYPES,
  ImageImportError,
  imageImportConfigured,
  readMedicinePack,
  type ImageMediaType,
} from "@/lib/medicine-image-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The form shrinks photos before sending; this only refuses a mistake. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/medicines/import/pack - read one medicine pack from a photo.
 *
 * The body is the raw image, its type in Content-Type. Nothing is written:
 * the reply is the field values the Add medicine form shows for the user to
 * check and correct, and only their Save creates the medicine.
 */
export const POST = withRoute(async (req) => {
  await requirePermission("medicine:write");

  if (!imageImportConfigured()) {
    throw ApiError.badRequest(
      "Reading a medicine from a photo is not switched on for this server yet. Ask the administrator to add an ANTHROPIC_API_KEY.",
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
    return ok(await readMedicinePack(data, mediaType as ImageMediaType));
  } catch (error) {
    if (error instanceof ImageImportError) throw ApiError.badRequest(error.message);
    throw error;
  }
});
