import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { SUPPLIER_PAYMENT_METHODS } from "@/lib/constants";

export { SUPPLIER_PAYMENT_METHODS };

/**
 * Money paid out to a supplier.
 *
 * Payments are append-only records rather than edits to a running balance, so
 * the ledger can always be recomputed from first principles and a mistaken
 * entry is corrected by a reversing entry, not by rewriting history.
 *
 * A payment may be applied to one specific invoice (`purchaseId`) or made
 * on account against the supplier's overall balance (`purchaseId` null).
 */
const supplierPaymentSchema = new Schema(
  {
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    /** Null for an on-account payment not tied to a single invoice. */
    purchaseId: {
      type: Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
      index: true,
    },
    grnNo: { type: String, default: "" },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: SUPPLIER_PAYMENT_METHODS, default: "cash" },
    paidOn: { type: Date, required: true },
    /** Cheque number, transaction id, or similar. */
    reference: { type: String, trim: true, default: "", maxlength: 120 },
    note: { type: String, trim: true, default: "", maxlength: 300 },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recordedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

supplierPaymentSchema.index({ supplierId: 1, paidOn: -1 });

export type SupplierPaymentDoc = InferSchemaType<typeof supplierPaymentSchema>;

export const SupplierPayment: Model<SupplierPaymentDoc> =
  (models.SupplierPayment as Model<SupplierPaymentDoc>) ??
  model<SupplierPaymentDoc>("SupplierPayment", supplierPaymentSchema);
