import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/lib/constants";

export { PAYMENT_MODES, PAYMENT_MODE_LABELS };
export type { PaymentMode };

/**
 * One dispensed line. A single cart line can produce several of these when
 * FEFO splits it across batches, so medicine names and prices are denormalised
 * here: a reprinted bill from last year must show what was actually charged,
 * even if the medicine has since been renamed or repriced.
 */
const saleItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true },
    medicineName: { type: String, required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    quantity: { type: Number, required: true, min: 1 },
    /** Pack unit captured at sale, for the IRD line (tablet, bottle, …). */
    unit: { type: String, default: "unit" },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    /**
     * What this stock cost the shop, captured at the moment of sale.
     *
     * Not derived from the batch at report time on purpose: posting a repeat
     * delivery of the same lot blends its costPrice by weighted average, so a
     * January sale looked up in March would be valued at March's cost. Profit
     * has to be computed against what was true when the sale happened.
     */
    unitCost: { type: Number, required: true, min: 0, default: 0 },
    /** quantity * unitCost, rounded. */
    lineCost: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    billNo: { type: String, required: true, unique: true, index: true },
    /** Numeric form of billNo, for cheap ordering and range queries. */
    billSeq: { type: Number, required: true, index: true },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    /** Walk-in name, when the sale is not tied to a saved customer record. */
    customerName: { type: String, trim: true, default: "" },
    /** Frozen at sale so a reprint still shows what was on the original. */
    customerPan: { type: String, trim: true, default: "" },
    customerAddress: { type: String, trim: true, default: "" },
    customerPhone: { type: String, trim: true, default: "" },
    items: {
      type: [saleItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: "A sale must contain at least one item.",
      },
    },
    /** Gross value of all items before discount. */
    subtotal: { type: Number, required: true, min: 0 },
    /** Cost of goods sold: the sum of every line's lineCost. */
    totalCost: { type: Number, required: true, min: 0, default: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    /**
     * The percentage the counter chose, when it chose one. Zero means the
     * discount was typed as a rupee amount. Kept so the printed bill can say
     * "Discount (10%)" instead of an unexplained round number.
     */
    discountPercent: { type: Number, required: true, min: 0, max: 100, default: 0 },
    /** subtotal - discount; the base VAT is charged on. */
    taxableAmount: { type: Number, required: true, min: 0 },
    vatRate: { type: Number, required: true, min: 0, default: 0.13 },
    vatAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentMode: {
      type: String,
      enum: PAYMENT_MODES,
      required: true,
      default: "cash",
    },
    soldBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    soldByName: { type: String, default: "" },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    /** Denormalised so a reprint shows the outlet that actually issued it. */
    branchName: { type: String, default: "" },
    /** Nepali fiscal year, e.g. 2082-83, matching the bill-number prefix. */
    fiscalYear: { type: String, default: "", index: true },
    /** Set the first time the original is sent to the printer. */
    printedAt: { type: Date, default: null },
    /** Reprints after the original must be labelled "Copy of Original – N". */
    reprintCount: { type: Number, default: 0, min: 0 },
    note: { type: String, trim: true, default: "" },
    /**
     * A voided bill stays on record - the bill number was issued, and a gap in
     * the sequence is exactly what an auditor asks about. Its stock goes back
     * to the batches it came from, and every revenue, cost and sales-velocity
     * query filters on `voidedAt: null` so the money side reads as if the sale
     * never happened.
     */
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    voidedByName: { type: String, default: "" },
    voidReason: { type: String, trim: true, default: "", maxlength: 300 },
  },
  { timestamps: true },
);

// The sales-history screen and the dashboard both read by date, newest first.
saleSchema.index({ createdAt: -1 });
saleSchema.index({ branchId: 1, createdAt: -1 });

export type SaleDoc = InferSchemaType<typeof saleSchema>;

export const Sale: Model<SaleDoc> =
  (models.Sale as Model<SaleDoc>) ?? model<SaleDoc>("Sale", saleSchema);
