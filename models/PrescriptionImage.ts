import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * The photo of the prescription behind a controlled-drug sale.
 *
 * Its own collection rather than a field on the Sale: bills are read in bulk by
 * every report, and the audit trail copies a bill's changes, so a picture on
 * the bill would slow the first and bloat the second. Written once, in the same
 * transaction as the bill, and never edited.
 */
const prescriptionImageSchema = new Schema(
  {
    pharmacyId: { type: Schema.Types.ObjectId, ref: "Pharmacy", required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true, unique: true },
    contentType: { type: String, required: true, default: "image/jpeg" },
    data: { type: Buffer, required: true },
  },
  { timestamps: true },
);

/** The photo's bytes from a lean read, which gives a BSON Binary rather than a Buffer. */
export function imageBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return (data as { buffer: Uint8Array }).buffer;
}

export type PrescriptionImageDoc = InferSchemaType<typeof prescriptionImageSchema>;

export const PrescriptionImage: Model<PrescriptionImageDoc> =
  (models.PrescriptionImage as Model<PrescriptionImageDoc>) ??
  model<PrescriptionImageDoc>("PrescriptionImage", prescriptionImageSchema);
