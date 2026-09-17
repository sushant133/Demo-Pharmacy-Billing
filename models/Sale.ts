import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/lib/constants";

import {
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  type PaymentStatus,
} from "@/lib/sale-payment";

export {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
};
export type { PaymentMode, PaymentStatus };

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
    /**
     * Units from this line that have come back. The original quantity stays
     * so the printed bill still matches what left the counter.
     */
    returnedQuantity: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const saleReturnItemSchema = new Schema(
  {
    lineIndex: { type: Number, required: true, min: 0 },
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true },
    medicineName: { type: String, required: true },
    batchNumber: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0, default: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    taxableAmount: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    lineCost: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const saleReturnSchema = new Schema(
  {
    returnedAt: { type: Date, required: true },
    returnedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    returnedByName: { type: String, default: "" },
    /** One of RETURN_REASONS. Blank on returns taken before the list existed. */
    reasonCode: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, required: true, maxlength: 300 },
    /**
     * The counter confirmed the goods were sealed, undamaged and in their
     * original packaging. Stored rather than assumed: it is the only record
     * that the physical check was made, and the only thing that distinguishes
     * a sound return from stock that should have been written off.
     */
    conditionConfirmed: { type: Boolean, default: false },
    /**
     * How the money went back: cash, reversed to the original payment, or
     * taken off what the customer still owed.
     *
     * Blank on returns recorded before the field existed. Read as "not
     * recorded" rather than defaulted to cash - a till reconciliation that
     * silently assumes cash left the drawer is worse than one that says it
     * does not know.
     */
    refundMethod: { type: String, trim: true, default: "" },
    items: {
      type: [saleReturnItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: "A return must contain at least one item.",
      },
    },
    units: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    taxableAmount: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

/**
 * One receipt against a bill.
 *
 * Append-only, exactly like `returns`: money taken at the till is the first
 * entry, and settling a due later adds another. Nothing edits a running
 * balance, so what was received can always be recomputed from the entries and
 * a mistaken receipt is corrected by a reversing one rather than by rewriting
 * history.
 */
const salePaymentSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: PAYMENT_MODES, required: true, default: "cash" },
    receivedAt: { type: Date, required: true },
    receivedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    receivedByName: { type: String, default: "" },
    /** Cheque number, wallet transaction id, or similar. */
    reference: { type: String, trim: true, default: "", maxlength: 120 },
    note: { type: String, trim: true, default: "", maxlength: 300 },
    /** True for the payment taken as the bill was raised. */
    atTill: { type: Boolean, default: false },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    billNo: { type: String, required: true, index: true },
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
    /**
     * What the customer actually handed over.
     *
     * Recorded rather than assumed, because the two facts it separates are
     * different: change given back (received above the total, cash) and a
     * balance still owed (received below it, a credit sale). Bills written
     * before this field existed read as 0, which no query treats as unpaid -
     * only `paymentMode: "credit"` means that.
     */
    amountReceived: { type: Number, required: true, min: 0, default: 0 },
    /** Every receipt against this bill. `amountReceived` is their sum. */
    payments: { type: [salePaymentSchema], default: [] },
    /**
     * Paid, partially paid, or credit/unpaid.
     *
     * Derived from the money - `settleSale` in lib/sale-payment.ts is the only
     * thing that decides it - but stored so the sales list and the customer
     * dues report can filter on it without reading every bill. Kept in sync on
     * every write that moves money: the sale itself, a later receipt, a return
     * and a void.
     */
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      required: true,
      default: "paid",
      index: true,
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
    /**
     * Customer returns after the sale. Each entry is a dated, authored
     * correction: stock goes back on the original lots, and the summary
     * fields below are what reports subtract so takings stay honest.
     */
    returns: { type: [saleReturnSchema], default: [] },
    returnedUnits: { type: Number, required: true, min: 0, default: 0 },
    returnedDiscount: { type: Number, required: true, min: 0, default: 0 },
    returnedTaxable: { type: Number, required: true, min: 0, default: 0 },
    returnedVat: { type: Number, required: true, min: 0, default: 0 },
    returnedTotal: { type: Number, required: true, min: 0, default: 0 },
    returnedCost: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true },
);

// Bill numbers are unique per pharmacy, not globally: two shops both start at INV-000001.
saleSchema.index({ pharmacyId: 1, billNo: 1 }, { unique: true });
// The customer-dues read: what one customer still owes, newest bill first.
saleSchema.index({ pharmacyId: 1, customerId: 1, paymentStatus: 1, createdAt: -1 });
// The sales-history screen and the dashboard both read by date, newest first.
saleSchema.index({ createdAt: -1 });
saleSchema.index({ pharmacyId: 1, createdAt: -1 });
saleSchema.index({ branchId: 1, createdAt: -1 });

export type SaleDoc = InferSchemaType<typeof saleSchema>;

export const Sale: Model<SaleDoc> =
  (models.Sale as Model<SaleDoc>) ?? model<SaleDoc>("Sale", saleSchema);
