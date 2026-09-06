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
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    genericName: { type: String, trim: true, default: "", maxlength: 200 },
    saltComposition: { type: String, trim: true, default: "", maxlength: 300 },
    manufacturer: { type: String, trim: true, default: "", maxlength: 200 },
    category: { type: String, trim: true, default: "Other", maxlength: 80 },
    unit: { type: String, enum: MEDICINE_UNITS, default: "tablet" },
    /** Units per strip/bottle - shown on the POS so staff know what "1" means. */
    packSize: { type: String, trim: true, default: "" },
    /**
     * Pieces in one strip (Pantop = 10). Bills still use a plain tablet
     * count; this only labels "1 strip" and lets the till sell 4 of 10.
     * Null is allowed: a syrup has no strip, and update validators run on
     * null (unlike document validation), so `min: 1` would reject saves.
     */
    unitsPerStrip: {
      type: Number,
      default: null,
      validate: {
        validator(value: number | null) {
          if (value == null) return true;
          return Number.isInteger(value) && value >= 1 && value <= 1000;
        },
        message: "Tablets in one strip must be a whole number between 1 and 1000.",
      },
    },
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
// Prefix search (`^query`) uses this; also keeps one pharmacy's catalogue free of dupes.
medicineSchema.index({ pharmacyId: 1, name: 1, manufacturer: 1 }, { unique: true });
medicineSchema.index({ pharmacyId: 1, category: 1 });

export type MedicineDoc = InferSchemaType<typeof medicineSchema>;

export const Medicine: Model<MedicineDoc> =
  (models.Medicine as Model<MedicineDoc>) ??
  model<MedicineDoc>("Medicine", medicineSchema);
