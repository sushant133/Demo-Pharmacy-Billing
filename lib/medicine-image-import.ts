import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { rowsToCsv } from "@/lib/medicine-import";

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

/** Header names the existing import parser already recognises. */
const HEADER = ["Name", "Generic", "Manufacturer", "Category", "Unit", "Pack size", "Purchase price", "MRP"];

export class ImageImportError extends Error {}

export function imageImportConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export async function readMedicineImage(
  data: Buffer,
  mediaType: ImageMediaType,
): Promise<{ csv: string; count: number; note: string }> {
  const client = new Anthropic();

  let response;
  try {
    response = await client.beta.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // A declined request is re-run on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(ResultSchema) },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
            },
            { type: "text", text: INSTRUCTIONS },
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

  if (response.stop_reason === "refusal") {
    throw new ImageImportError("That photo could not be processed. Try a photo of just the medicine list.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ImageImportError("That list is too long to read in one photo. Photograph it in parts.");
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new ImageImportError("The list in that photo could not be read. Try a clearer photo.");
  }

  const { csv, count } = imageRowsToCsv(parsed.rows);
  return { csv, count, note: parsed.note.trim() };
}

/** The rows read from a photo as import text, blank-named lines dropped. */
export function imageRowsToCsv(rows: readonly ImageImportRow[]): { csv: string; count: number } {
  const kept = rows.filter((row) => row.name.trim() !== "");
  const csv = rowsToCsv([
    HEADER,
    ...kept.map((row) => [
      row.name.trim(),
      row.generic.trim(),
      row.manufacturer.trim(),
      row.category.trim(),
      row.unit.trim().toLowerCase(),
      row.packSize.trim(),
      row.purchasePrice ?? "",
      row.mrp ?? "",
    ]),
  ]);
  return { csv, count: kept.length };
}
