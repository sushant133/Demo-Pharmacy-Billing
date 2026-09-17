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
    /**
     * The shop's own code for this line - its SKU.
     *
     * Distinct from `barcode`, which is whatever the manufacturer printed on
     * the pack and which a scanner reads. This one is chosen by the pharmacy:
     * it goes on the shelf label, on the stock-take sheet and in whatever the
     * accountant keeps, and it stays the same when the supplier changes the
     * artwork or the pack is relabelled.
     *
     * Stored upper-cased so "amx-500" and "AMX-500" cannot both exist and be
     * treated as two different products. Uniqueness is per pharmacy and only
     * among medicines that have one, so the blank default never collides with
     * itself - the same shape as `barcode` below.
     */
    sku: { type: String, trim: true, uppercase: true, default: "", maxlength: 40 },
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
    /**
     * The code printed on the pack, as the scanner reads it.
     *
     * Free text rather than a checked EAN: pharmacies relabel, repack and
     * print their own shelf codes, and a till that refuses a scan because the
     * check digit is wrong is a till nobody uses. Uniqueness is per pharmacy
     * and only among medicines that have one, so the blank default does not
     * collide with itself.
     */
    barcode: { type: String, trim: true, default: "", maxlength: 60 },
    /**
     * Indicative prices for this line, used to pre-fill a delivery.
     *
     * Emphatically *not* what the till charges. Stock lives on `Batch` and so
     * does its money: a lot is bought at a price and sold at a price, FEFO
     * decides which lot leaves, and COGS is frozen onto the sale from that
     * lot. Two lots of the same drug routinely carry different figures, which
     * is exactly why a single number on the catalogue cannot be the truth.
     *
     * What they are for is the gap `latestBatchPrices` cannot fill: a medicine
     * added to the catalogue before it has ever been delivered has no previous
     * lot to copy from, so the GRN form starts blank and somebody types the
     * MRP off the box. Recording it once here saves that, and nothing else
     * reads these fields.
     *
     * Null rather than 0 when unknown - zero is a real price somebody could
     * deliberately set, and "free" and "not filled in" must not collapse.
     */
    defaultCostPrice: { type: Number, min: 0, default: null },
    defaultSalePrice: { type: Number, min: 0, default: null },
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
// A scan is an exact lookup on the hot path of the till, so it gets its own
// index. Partial, because the empty default is the common case and two
// medicines without a barcode are not duplicates of each other.
medicineSchema.index(
  { pharmacyId: 1, barcode: 1 },
  {
    unique: true,
    partialFilterExpression: { barcode: { $type: "string", $gt: "" } },
  },
);
// The shop's own code, same shape as the barcode index above: unique within a
// pharmacy, and only over the medicines that actually carry one.
medicineSchema.index(
  { pharmacyId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: "string", $gt: "" } },
  },
);

export type MedicineDoc = InferSchemaType<typeof medicineSchema>;

export const Medicine: Model<MedicineDoc> =
  (models.Medicine as Model<MedicineDoc>) ??
  model<MedicineDoc>("Medicine", medicineSchema);
