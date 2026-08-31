import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  MEDICINE_CATEGORIES,
  MEDICINE_UNITS,
  type MedicineUnit,
} from "@/lib/constants";

// Re-exported so existing model consumers keep one import site.
export { MEDICINE_CATEGORIES, MEDICINE_UNITS };
export type { MedicineUnit };

const medicineSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    genericName: { type: String, trim: true, default: "", maxlength: 200 },
    saltComposition: { type: String, trim: true, default: "", maxlength: 300 },
    manufacturer: { type: String, trim: true, default: "", maxlength: 200 },
    category: { type: String, trim: true, default: "Other", maxlength: 80 },
    unit: { type: String, enum: MEDICINE_UNITS, default: "tablet" },
    /** Units per strip/bottle - shown on the POS so staff know what "1" means. */
    packSize: { type: String, trim: true, default: "" },
    /** Prescription-only medicines get a visible warning at the counter. */
    requiresPrescription: { type: Boolean, default: false },
    /** Per-medicine override of LOW_STOCK_THRESHOLD. */
    reorderLevel: { type: Number, min: 0, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Text index powers the POS search box across brand, generic and salt names.
medicineSchema.index({ name: "text", genericName: "text", saltComposition: "text" });
// Prefix search (`^query`) uses this; also keeps the catalogue free of dupes.
medicineSchema.index({ name: 1, manufacturer: 1 }, { unique: true });
medicineSchema.index({ category: 1 });

export type MedicineDoc = InferSchemaType<typeof medicineSchema>;

export const Medicine: Model<MedicineDoc> =
  (models.Medicine as Model<MedicineDoc>) ??
  model<MedicineDoc>("Medicine", medicineSchema);
