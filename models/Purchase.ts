import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { PAYMENT_STATUSES, PURCHASE_STATUSES } from "@/lib/constants";

export { PURCHASE_STATUSES, PAYMENT_STATUSES };

/**
 * One line of a supplier invoice.
 *
 * `batchId` is null until the purchase is posted. Posting is the moment stock
 * becomes real: it creates (or tops up) a Batch and writes the id back here,
 * which is what ties every unit on the shelf to the GRN it arrived on.
 */
const purchaseItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    /** Denormalised so a GRN reprints correctly after a catalogue rename. */
    medicineName: { type: String, required: true },
    batchNumber: { type: String, required: true, trim: true, maxlength: 60 },
    mfgDate: { type: Date, default: null },
    expiryDate: { type: Date, required: true },
    /** Units billed on the invoice. */
    quantity: { type: Number, required: true, min: 0 },
    /** Bonus units ("10 + 2 free"). Received but not billed. */
    freeQuantity: { type: Number, required: true, min: 0, default: 0 },
    /** Invoice rate per billed unit. */
    costPrice: { type: Number, required: true, min: 0 },
    /** Net cost per shelf unit once free units and discount are spread in. */
    effectiveUnitCost: { type: Number, required: true, min: 0, default: 0 },
    /** Price the shop will sell at; copied onto the Batch when posted. */
    salePrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    /** quantity * costPrice - discount. */
    lineTotal: { type: Number, required: true, min: 0, default: 0 },
    /** Set on post. Null on a draft or a cancelled GRN. */
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null },
    /** True when posting topped up an existing lot instead of creating one. */
    toppedUpExisting: { type: Boolean, default: false },
  },
  { _id: false },
);

const purchaseSchema = new Schema(
  {
    /** Human-facing goods-received note number, e.g. GRN-000042. */
    grnNo: { type: String, required: true, unique: true, index: true },
    grnSeq: { type: Number, required: true, index: true },

    supplierId: {
      type: Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    supplierName: { type: String, required: true },

    /** The supplier's own invoice/bill reference and its date. */
    invoiceNo: { type: String, trim: true, default: "", maxlength: 60 },
    invoiceDate: { type: Date, default: null },
    /** When the goods physically arrived. */
    receivedDate: { type: Date, required: true },

    status: {
      type: String,
      enum: PURCHASE_STATUSES,
      required: true,
      default: "draft",
      index: true,
    },

    items: {
      type: [purchaseItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: "A purchase must have at least one line.",
      },
    },

    subtotal: { type: Number, required: true, min: 0, default: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    otherCharges: { type: Number, required: true, min: 0, default: 0 },
    taxableAmount: { type: Number, required: true, min: 0, default: 0 },
    vatRate: { type: Number, required: true, min: 0, default: 0 },
    vatAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0, default: 0 },

    /** Derived from SupplierPayment records; see lib/suppliers.ts. */
    amountPaid: { type: Number, required: true, min: 0, default: 0 },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      required: true,
      default: "unpaid",
      index: true,
    },
    /** receivedDate + the supplier's credit period, fixed at post time. */
    dueDate: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelReason: { type: String, trim: true, default: "", maxlength: 300 },

    notes: { type: String, trim: true, default: "", maxlength: 500 },
    /** The outlet the delivery was received into; where posting creates stock. */
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    branchName: { type: String, default: "" },
  },
  { timestamps: true },
);

// The purchase register reads newest-first, and payables filter by status.
purchaseSchema.index({ createdAt: -1 });
purchaseSchema.index({ branchId: 1, createdAt: -1 });
purchaseSchema.index({ supplierId: 1, status: 1 });
purchaseSchema.index({ status: 1, paymentStatus: 1 });

export type PurchaseDoc = InferSchemaType<typeof purchaseSchema>;

export const Purchase: Model<PurchaseDoc> =
  (models.Purchase as Model<PurchaseDoc>) ??
  model<PurchaseDoc>("Purchase", purchaseSchema);
