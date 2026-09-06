import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const PHARMACY_STATUSES = ["active", "suspended"] as const;
export type PharmacyStatus = (typeof PHARMACY_STATUSES)[number];

/**
 * One tenant on the platform: an independent pharmacy, with its own
 * catalogue, stock, bills, staff and settings.
 *
 * Superadmin creates these. Everything the counter does is scoped to one
 * of them; two pharmacies sharing a database must never see each other's
 * records. The slug is the stable handle; the name is what the owner
 * sees on the sign-in card and in the sidebar.
 */
const pharmacySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 40,
      index: true,
    },
    legalName: { type: String, trim: true, default: "", maxlength: 160 },
    status: {
      type: String,
      enum: PHARMACY_STATUSES,
      default: "active",
      index: true,
    },
    /** The admin login created with this pharmacy. */
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    ownerName: { type: String, trim: true, default: "", maxlength: 120 },
    ownerEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      maxlength: 160,
    },
    notes: { type: String, trim: true, default: "", maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

export type PharmacyDoc = InferSchemaType<typeof pharmacySchema>;

export const Pharmacy: Model<PharmacyDoc> =
  (models.Pharmacy as Model<PharmacyDoc>) ??
  model<PharmacyDoc>("Pharmacy", pharmacySchema);
