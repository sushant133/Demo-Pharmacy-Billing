import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  MOVEMENT_KINDS,
  MOVEMENT_REASONS,
  type MovementKind,
} from "@/lib/movement-kinds";

export { MOVEMENT_KINDS, MOVEMENT_REASONS };
export type { MovementKind };

/**
 * One change to a lot's count that has no other record.
 *
 * Purchases and sales already write their own history - a GRN says what came
 * in, a bill says what went out - so they are read from there rather than
 * copied here. What had no home at all is everything else: a count corrected
 * after a stock-take, a box dropped on the floor, an expired lot pulled off
 * the shelf, units sent to another branch. Those changed stock with nothing
 * in the system to say who did it or why, which is the gap this closes.
 *
 * Append-only, like a sale's returns and a bill's payments. Nothing edits a
 * movement: a mistaken adjustment is corrected by another adjustment, so how
 * the count got where it is stays readable afterwards. `balanceAfter` is
 * stamped at write time for exactly that reason - it is what the shelf held
 * when this happened, not what it holds now.
 */
const stockMovementSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    branchName: { type: String, default: "" },
    medicineId: {
      type: Schema.Types.ObjectId,
      ref: "Medicine",
      required: true,
      index: true,
    },
    /** Denormalised, so a movement still reads after a medicine is renamed. */
    medicineName: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null },
    batchNumber: { type: String, default: "" },
    expiryDate: { type: Date, default: null },
    unit: { type: String, default: "unit" },

    kind: { type: String, enum: MOVEMENT_KINDS, required: true, index: true },
    /**
     * Which way the units went. Derived from `kind` and stored anyway, because
     * the two ledger screens are "everything in" and "everything out" and
     * neither should have to carry a list of which kinds count as which.
     */
    direction: { type: String, enum: ["in", "out"], required: true, index: true },
    /** Always positive. `direction` carries the sign. */
    quantity: { type: Number, required: true, min: 1 },
    /** The lot's count immediately after this movement was applied. */
    balanceAfter: { type: Number, required: true, min: 0 },

    /** Cost per unit at the time, so a write-off can be valued. */
    unitCost: { type: Number, required: true, min: 0, default: 0 },
    /** quantity * unitCost, rounded. What the movement was worth. */
    value: { type: Number, required: true, min: 0, default: 0 },

    /** One of MOVEMENT_REASONS for the kind. Blank where the kind says it all. */
    reasonCode: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "", maxlength: 300 },
    note: { type: String, trim: true, default: "", maxlength: 300 },

    /**
     * The other half of a transfer.
     *
     * A transfer is two movements - out of one branch, into another - sharing
     * a `transferRef` so the pair can be read back as one event, and each
     * naming the branch at the far end so either side reads on its own.
     */
    transferRef: { type: String, default: "", index: true },
    counterpartBranchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    counterpartBranchName: { type: String, default: "" },

    performedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    performedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

// The ledger screens read newest-first, within a branch scope and a direction.
stockMovementSchema.index({ pharmacyId: 1, createdAt: -1 });
stockMovementSchema.index({ branchId: 1, direction: 1, createdAt: -1 });
stockMovementSchema.index({ pharmacyId: 1, kind: 1, createdAt: -1 });
// "What has happened to this lot?" - the history shown beside a batch.
stockMovementSchema.index({ batchId: 1, createdAt: -1 });

export type StockMovementDoc = InferSchemaType<typeof stockMovementSchema>;

export const StockMovement: Model<StockMovementDoc> =
  (models.StockMovement as Model<StockMovementDoc>) ??
  model<StockMovementDoc>("StockMovement", stockMovementSchema);
