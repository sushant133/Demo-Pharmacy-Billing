import { photoRowsToCsv, type PhotoImportRow } from "@/lib/medicine-import";
import { readImageText } from "@/lib/medicine-ocr-engine";
import { parseListText, parsePackText, type CatalogueEntry, type OcrPackReading, readerWarning } from "@/lib/medicine-ocr";

/**
 * Read a photo of a medicine list, or of one pack, into medicine fields.
 *
 * A supplier's bill, a printed price list, the front of a box: the text is read
 * by OCR.space when a key is configured, otherwise by Tesseract on this server
 * (lib/medicine-ocr-engine.ts), and the rules in lib/medicine-ocr.ts turn it into
 * rows or form values. With a key, the photo is sent to that third party.
 *
 * Nothing is written here - the shop sees every row or field, can correct
 * it, and only then saves. A misread line is therefore a typo to fix, never
 * bad stock.
 *
 * Server-only.
 */

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export class ImageImportError extends Error {}

/** OCR failures - a corrupt image, a worker that would not start - in the pharmacist's words. */
async function ocrLines(data: Buffer, layout: "pack" | "list") {
  try {
    return await readImageText(data, layout);
  } catch (error) {
    console.error("[photo-reader] OCR failed", error);
    throw new ImageImportError("That photo could not be read. Try a clearer JPG or PNG photo.");
  }
}

export async function readMedicineImage(
  data: Buffer,
  // Accepted for the routes' sake; sharp detects the format itself.
  _mediaType: ImageMediaType,
  /** The pharmacy's own medicines: read names are matched against them. */
  catalogue: readonly CatalogueEntry[] = [],
): Promise<{ csv: string; count: number; rows: PhotoImportRow[]; note: string }> {
  const lines = await ocrLines(data, "list");
  const parsed = parseListText(lines, catalogue);
  const rows = parsed.rows.filter((row) => row.name.trim() !== "");
  const { csv, count } = imageRowsToCsv(rows);
  // The rows as well as the text, for the editable review table.
  return { csv, count, rows, note: [readerWarning(lines), parsed.note.trim()].filter(Boolean).join(" ") };
}

// ---------------------------------------------------------------------------
// One medicine pack, for the Add medicine form
// ---------------------------------------------------------------------------

export type PackReading = OcrPackReading;

/** What the form should be filled with, in the form's own terms. */
export interface PackFill {
  name: string;
  genericName: string;
  saltComposition: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  barcode: string;
  unitsPerStrip: number | null;
  /** Per piece, the way the form stores MRP. */
  defaultSalePrice: number | null;
  /** How the printed MRP was turned into a per-piece one, when it was. */
  mrpNote: string;
  note: string;
}

/** The pack reading, tidied into form values. Pure, so it is testable. */
export function packReadingToFill(reading: PackReading): PackFill {
  const unit = reading.unit.trim().toLowerCase();
  const pieces =
    reading.mrpForPieces && reading.mrpForPieces > 0 ? reading.mrpForPieces : null;
  let defaultSalePrice: number | null = null;
  let mrpNote = "";
  if (reading.mrp != null && reading.mrp > 0) {
    if (pieces && pieces > 1) {
      defaultSalePrice = Math.round((reading.mrp / pieces) * 100) / 100;
      mrpNote = `Pack MRP Rs. ${reading.mrp} for ${pieces} → Rs. ${defaultSalePrice.toFixed(2)} each.`;
    } else {
      defaultSalePrice = reading.mrp;
    }
  }
  const barcode = reading.barcode.replace(/\D/g, "");

  return {
    name: reading.name.trim(),
    genericName: reading.genericName.trim(),
    saltComposition: reading.saltComposition.trim(),
    manufacturer: reading.manufacturer.trim(),
    category: reading.category.trim(),
    unit,
    packSize: reading.packSize.trim(),
    // Only a plausible retail code; a half-read number is worse than none.
    barcode: barcode.length >= 8 && barcode.length <= 14 ? barcode : "",
    unitsPerStrip:
      reading.unitsPerStrip && reading.unitsPerStrip > 0 && reading.unitsPerStrip <= 1000
        ? reading.unitsPerStrip
        : null,
    defaultSalePrice,
    mrpNote,
    note: reading.note.trim(),
  };
}

export async function readMedicinePack(
  data: Buffer,
  _mediaType: ImageMediaType,
): Promise<PackFill> {
  const lines = await ocrLines(data, "pack");
  const reading = parsePackText(lines);
  if (!reading.isMedicinePack) {
    throw new ImageImportError(
      reading.note.trim() || "That does not look like a medicine pack. Photograph the front of the box or strip.",
    );
  }
  const fill = packReadingToFill(reading);
  return { ...fill, note: [readerWarning(lines), fill.note].filter(Boolean).join(" ") };
}

/** The rows read from a photo as import text, blank-named lines dropped. */
export function imageRowsToCsv(rows: readonly PhotoImportRow[]): { csv: string; count: number } {
  return photoRowsToCsv(rows);
}
