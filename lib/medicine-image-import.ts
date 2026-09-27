import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { photoRowsToCsv, type PhotoImportRow } from "@/lib/medicine-import";

/**
 * Read a photo of a medicine list into import rows.
 *
 * A supplier's bill, a handwritten stock list, a printed price list: Claude
 * reads the picture and returns one row per medicine, which becomes the same
 * CSV the import panel already previews and validates. Nothing is written
 * here - the shop sees every row, can correct it in the text box, and only
 * then imports. A misread line is therefore a typo to fix, never bad stock.
 *
 * Server-only: needs ANTHROPIC_API_KEY, which must never reach the browser.
 */

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

const RowSchema = z.object({
  name: z.string().describe("Brand name with strength, exactly as written, e.g. 'Cetzine 10mg'."),
  generic: z.string().describe("Generic / salt name if shown, else empty."),
  manufacturer: z.string().describe("Company or manufacturer if shown, else empty."),
  category: z.string().describe("Therapeutic category if shown or obvious, else empty."),
  unit: z
    .string()
    .describe(
      "Dosage form in lowercase singular: tablet, capsule, syrup, injection, ointment, cream, drops, inhaler, sachet, suppository, or another word if none fit. Empty if unknown.",
    ),
  packSize: z.string().describe("Pack as written, e.g. '10x10', '1x15', '100ml'. Empty if not shown."),
  purchasePrice: z.number().nullable().describe("Cost / rate per unit in Nepali rupees, or null."),
  mrp: z.number().nullable().describe("MRP / selling price per unit in Nepali rupees, or null."),
});

const ResultSchema = z.object({
  rows: z.array(RowSchema),
  note: z
    .string()
    .describe(
      "One short sentence for the pharmacist: anything unreadable or uncertain, or empty if the list was clear.",
    ),
});

export type ImageImportRow = z.infer<typeof RowSchema>;

const INSTRUCTIONS = `This is a photo from a pharmacy in Nepal: a supplier's bill, a stock list, or a price list, printed or handwritten.

List every medicine line on it as a row. Copy names exactly as written, including strength (mg, ml); do not correct spellings you are unsure of or invent anything that is not on the page. Skip headings, totals, taxes, discounts, signatures and anything that is not a medicine or pharmacy product.

Prices are Nepali rupees. If the bill shows a line amount and a quantity, use the per-unit rate, not the line total. Leave a field empty (or null for prices) when the photo does not show it.

If the photo is not a medicine list at all, return no rows and say so in the note.`;

export class ImageImportError extends Error {}

export function imageImportConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * One photo in, one schema-checked answer out. Shared by the list reader and
 * the single-pack reader; every failure becomes an ImageImportError whose
 * message is fit to show the pharmacist.
 */
async function readImage<Schema extends z.ZodType>(
  data: Buffer,
  mediaType: ImageMediaType,
  instructions: string,
  schema: Schema,
  what: { refused: string; tooLong: string; unreadable: string },
): Promise<z.infer<Schema>> {
  const client = new Anthropic();

  let response;
  try {
    response = await client.beta.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // A declined request is re-run on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(schema) },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
            },
            { type: "text", text: instructions },
          ],
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new ImageImportError("The photo reader is not set up correctly on the server (API key rejected).");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new ImageImportError("The photo reader is busy. Try again in a minute.");
    }
    if (error instanceof Anthropic.BadRequestError) {
      throw new ImageImportError("That image could not be read. Try a clearer, smaller photo.");
    }
    if (error instanceof Anthropic.APIError) {
      throw new ImageImportError("The photo reader is unavailable right now. Try again shortly.");
    }
    throw error;
  }

  if (response.stop_reason === "refusal") throw new ImageImportError(what.refused);
  if (response.stop_reason === "max_tokens") throw new ImageImportError(what.tooLong);

  const parsed = response.parsed_output;
  if (!parsed) throw new ImageImportError(what.unreadable);
  return parsed as z.infer<Schema>;
}

export async function readMedicineImage(
  data: Buffer,
  mediaType: ImageMediaType,
): Promise<{ csv: string; count: number; rows: ImageImportRow[]; note: string }> {
  const parsed = await readImage(data, mediaType, INSTRUCTIONS, ResultSchema, {
    refused: "That photo could not be processed. Try a photo of just the medicine list.",
    tooLong: "That list is too long to read in one photo. Photograph it in parts.",
    unreadable: "The list in that photo could not be read. Try a clearer photo.",
  });

  const rows = parsed.rows.filter((row) => row.name.trim() !== "");
  const { csv, count } = imageRowsToCsv(rows);
  // The rows as well as the text, for the editable review table.
  return { csv, count, rows, note: parsed.note.trim() };
}

// ---------------------------------------------------------------------------
// One medicine pack, for the Add medicine form
// ---------------------------------------------------------------------------

const PackSchema = z.object({
  isMedicinePack: z
    .boolean()
    .describe("False if the photo is not a medicine or pharmacy product pack."),
  name: z.string().describe("Brand name with strength as printed, e.g. 'Pantop 40'. Empty if unreadable."),
  genericName: z.string().describe("Generic name(s), e.g. 'Pantoprazole'. Empty if not printed."),
  saltComposition: z
    .string()
    .describe("Composition with amounts as printed, e.g. 'Pantoprazole Sodium 40mg'. Empty if not printed."),
  manufacturer: z.string().describe("Manufacturer or marketer company name. Empty if not printed."),
  category: z
    .string()
    .describe(
      "Therapeutic category in one or two words, e.g. Analgesic, Antibiotic, Antacid, Antihistamine, Antidiabetic, Antihypertensive, Cardiac, Dermatology, Gastro, Respiratory, Supplement, Ophthalmic. Empty if unsure.",
    ),
  unit: z
    .string()
    .describe(
      "Dosage form, lowercase singular: tablet, capsule, syrup, injection, ointment, cream, drops, inhaler, sachet, suppository, or another word if none fit. Empty if unsure.",
    ),
  packSize: z
    .string()
    .describe("Pack as printed or implied, e.g. '10x10' (strips x pieces), '1x15', '100ml'. Empty if not shown."),
  barcode: z
    .string()
    .describe("Only the digits printed under the barcode (EAN/UPC), no spaces. Empty if no digits are legible."),
  unitsPerStrip: z
    .number()
    .int()
    .nullable()
    .describe("Tablets or capsules in one strip/blister, if shown. Null otherwise."),
  mrp: z.number().nullable().describe("The MRP amount printed, in Nepali rupees, exactly as printed. Null if none."),
  mrpForPieces: z
    .number()
    .int()
    .nullable()
    .describe(
      "How many pieces (tablets/capsules/bottles/tubes) that printed MRP is for: 10 for 'MRP per strip of 10', 1 for a bottle or a per-tablet price. Null if unclear.",
    ),
  note: z
    .string()
    .describe("One short sentence for the pharmacist about anything unclear or guessed; empty if the pack was clear."),
});

export type PackReading = z.infer<typeof PackSchema>;

const PACK_INSTRUCTIONS = `This is a photo of a medicine pack (box, strip, bottle or tube) taken at a pharmacy in Nepal.

Read what is printed on it to fill the fields. Copy text exactly as printed; do not guess brand names, strengths, companies or numbers that are not legible, and never invent a barcode - leave a field empty (or null) instead. Category may be inferred from the generic name if it is obvious.

If the photo is not a medicine or pharmacy product, set isMedicinePack to false and leave the other fields empty.`;

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

/** The model's reading, tidied into form values. Pure, so it is testable. */
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
  mediaType: ImageMediaType,
): Promise<PackFill> {
  const reading = await readImage(data, mediaType, PACK_INSTRUCTIONS, PackSchema, {
    refused: "That photo could not be processed. Try a photo of just the medicine pack.",
    tooLong: "That pack could not be read in one go. Try a closer photo of the front.",
    unreadable: "The pack in that photo could not be read. Try a clearer, closer photo.",
  });
  if (!reading.isMedicinePack) {
    throw new ImageImportError(
      reading.note.trim() || "That does not look like a medicine pack. Photograph the front of the box or strip.",
    );
  }
  return packReadingToFill(reading);
}

/** The rows read from a photo as import text, blank-named lines dropped. */
export function imageRowsToCsv(rows: readonly PhotoImportRow[]): { csv: string; count: number } {
  return photoRowsToCsv(rows);
}
