import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A physical lot of one medicine, at one branch, with its own expiry and
 * pricing.
 *
 * Stock lives here, never on Medicine: two lots of the same drug can have
 * different costs, prices and expiry dates, and FEFO needs them separate.
 *
 * Since Phase 2, batches are created only by posting a Purchase (GRN) - there
 * is no direct create route. Every unit on the shelf is therefore traceable to
 * the supplier delivery it arrived on, via `grnId`.
 *
 * Since Phase 4 a lot also belongs to a branch. The same lot number legitimately
 * exists at two outlets - one delivery split across them - so the uniqueness
 * rule is per branch, and those two documents are genuinely separate stock:
 * one cannot fill a shortage at the other without a stock transfer.
 */
const batchSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    medicineId: {
      type: Schema.Types.ObjectId,
      ref: "Medicine",
      required: true,
      index: true,
    },
    batchNumber: { type: String, required: true, trim: true, maxlength: 60 },
    mfgDate: { type: Date, default: null },
    expiryDate: { type: Date, required: true },
    /** Units currently on the shelf. Never negative - guarded on every write. */
    quantity: { type: Number, required: true, min: 0, default: 0 },
    /** Units originally received; kept so sold-through can be reported. */
    initialQuantity: { type: Number, required: true, min: 0, default: 0 },
    costPrice: { type: Number, required: true, min: 0 },
    salePrice: { type: Number, required: true, min: 0 },
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    /** The GRN that brought this lot in. Null only for pre-Phase-2 stock. */
    grnId: {
      type: Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
      index: true,
    },
    grnNo: { type: String, default: "" },
    /** The transfer that moved this lot here, when it came from another branch. */
    transferId: {
      type: Schema.Types.ObjectId,
      ref: "Transfer",
      default: null,
      index: true,
    },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

// The same lot number must not be entered twice for one medicine *at one
// branch*. Across branches it is expected: one delivery split between outlets,
// or a transfer landing a lot that already exists at the destination.
batchSchema.index({ branchId: 1, medicineId: 1, batchNumber: 1 }, { unique: true });
// The FEFO read path: stock for a medicine at a branch, earliest expiry first.
batchSchema.index({ branchId: 1, medicineId: 1, expiryDate: 1, quantity: 1 });
// The expiring-soon report scans by expiry across a branch's in-stock lots.
batchSchema.index({ branchId: 1, expiryDate: 1 });

batchSchema.pre("validate", function seedInitialQuantity(next) {
  if (this.isNew && !this.initialQuantity) {
    this.initialQuantity = this.quantity ?? 0;
  }
  next();
});

export type BatchDoc = InferSchemaType<typeof batchSchema>;

export const Batch: Model<BatchDoc> =
  (models.Batch as Model<BatchDoc>) ?? model<BatchDoc>("Batch", batchSchema);
