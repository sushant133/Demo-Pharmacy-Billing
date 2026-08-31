import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A distributor or manufacturer the shop buys from.
 *
 * `outstandingBalance` is deliberately NOT stored here. It is derived from
 * posted purchases minus recorded payments (see lib/suppliers.ts): a stored
 * running total is one failed write away from lying about money owed, and a
 * pharmacy that mistrusts its payables numbers stops using them.
 */
const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    contactPerson: { type: String, trim: true, default: "", maxlength: 120 },
    phone: { type: String, trim: true, default: "", maxlength: 40, index: true },
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    /** PAN / VAT registration number, needed on the purchase register. */
    panNo: { type: String, trim: true, default: "", maxlength: 30 },
    /** Credit period in days; drives the due date on a posted invoice. */
    paymentTermsDays: { type: Number, min: 0, default: 0 },
    /**
     * Balance carried in from whatever the shop used before this system.
     * Positive means the shop already owed the supplier on day one.
     */
    openingBalance: { type: Number, default: 0 },
    notes: { type: String, trim: true, default: "", maxlength: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

supplierSchema.index({ name: 1 }, { unique: true });
supplierSchema.index({ name: "text", contactPerson: "text", phone: "text" });

export type SupplierDoc = InferSchemaType<typeof supplierSchema>;

export const Supplier: Model<SupplierDoc> =
  (models.Supplier as Model<SupplierDoc>) ??
  model<SupplierDoc>("Supplier", supplierSchema);
