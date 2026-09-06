import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A physical outlet of one pharmacy.
 *
 * Phase 4 turns `branch` from a label into a real thing, because stock is not
 * fungible across a distance: 40 boxes sitting in Pokhara cannot fill a
 * shortage at the Kathmandu counter, and a low-stock alert that mixes the two
 * tells the pharmacist to order something they already have. So a Batch now
 * belongs to a branch, and FEFO only ever sees the stock in the room.
 *
 * Each branch carries its own printed identity. Nepali VAT invoices must show
 * the issuing outlet's own name, address and PAN, not the company's - which is
 * also what Phase 5's IRD work will need.
 *
 * Codes are unique per pharmacy, not globally: two vendors can both have a
 * `main` outlet.
 */
const branchSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    /** Short stable handle used in URLs and the branch switcher. */
    code: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 30,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    phone: { type: String, trim: true, default: "", maxlength: 40 },
    /** Falls back to the company PAN from config when empty. */
    panNo: { type: String, trim: true, default: "", maxlength: 30 },
    /**
     * Where a new user, an unscoped script or a migration puts things when no
     * branch was named. Exactly one branch per pharmacy should carry it;
     * `setDefaultBranch` clears the flag elsewhere rather than trusting
     * callers to.
     */
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

branchSchema.index({ pharmacyId: 1, code: 1 }, { unique: true });
branchSchema.index({ pharmacyId: 1, isDefault: 1 });

export type BranchDoc = InferSchemaType<typeof branchSchema>;

export const Branch: Model<BranchDoc> =
  (models.Branch as Model<BranchDoc>) ?? model<BranchDoc>("Branch", branchSchema);
