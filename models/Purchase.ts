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
    /** If true, posting copies this sale price onto other in-stock lots of the medicine. */
    applySalePriceToStock: { type: Boolean, default: false },
    /** Running total sent back to the supplier off this line. */
    returnedQuantity: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

/** One line of one debit note. */
const purchaseReturnItemSchema = new Schema(
  {
    /** Index into `items`, so the note ties back to the invoice line. */
    lineIndex: { type: Number, required: true, min: 0 },
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    medicineName: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true },
    batchNumber: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    /** Net cost per shelf unit at the time the goods came in. */
    unitCost: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/**
 * One consignment sent back to the supplier.
 *
 * Append-only, like a bill's returns and payments. A posted GRN is never
 * rewritten - it still says what arrived, which is what makes it reconcilable
 * against the supplier's own invoice. What went back is recorded beside it,
 * and `lib/suppliers.ts` subtracts the running total from what is owed.
 */
const purchaseReturnSchema = new Schema(
  {
    returnedAt: { type: Date, required: true },
    returnedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    returnedByName: { type: String, default: "" },
    /** One of PURCHASE_RETURN_REASONS. */
    reasonCode: { type: String, required: true, trim: true },
    reason: { type: String, trim: true, default: "", maxlength: 300 },
    /** The supplier's own credit note reference, once they issue one. */
    creditNoteNo: { type: String, trim: true, default: "", maxlength: 60 },
    items: { type: [purchaseReturnItemSchema], required: true },
    units: { type: Number, required: true, min: 0 },
    /** What the shop is owed for this consignment. */
    totalAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const purchaseSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    /** Human-facing goods-received note number, e.g. GRN-000042. */
    grnNo: { type: String, required: true, index: true },
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

    /**
     * Goods sent back, and the running totals off them.
     *
     * Stored on the GRN rather than in a collection of their own for the same
     * reason a bill keeps its returns: the only question anyone asks is "what
     * happened to *this* delivery", and the answer should not need a join.
     */
    returns: { type: [purchaseReturnSchema], default: [] },
    returnedUnits: { type: Number, required: true, min: 0, default: 0 },
    /** Total credit raised against this GRN. Subtracted from what is owed. */
    returnedTotal: { type: Number, required: true, min: 0, default: 0 },

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

purchaseSchema.index({ pharmacyId: 1, grnNo: 1 }, { unique: true });
// The purchase register reads newest-first, and payables filter by status.
purchaseSchema.index({ createdAt: -1 });
purchaseSchema.index({ pharmacyId: 1, createdAt: -1 });
purchaseSchema.index({ branchId: 1, createdAt: -1 });
purchaseSchema.index({ supplierId: 1, status: 1 });
purchaseSchema.index({ pharmacyId: 1, status: 1, paymentStatus: 1 });

export type PurchaseDoc = InferSchemaType<typeof purchaseSchema>;

export const Purchase: Model<PurchaseDoc> =
  (models.Purchase as Model<PurchaseDoc>) ??
  model<PurchaseDoc>("Purchase", purchaseSchema);
