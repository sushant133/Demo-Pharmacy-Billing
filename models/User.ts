import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { ROLES } from "@/lib/roles";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ROLES, default: "admin" },
    /**
     * The pharmacy this account belongs to. Null only for the platform
     * superadmin, who creates pharmacies rather than working inside one.
     */
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      default: null,
      index: true,
    },
    /** The outlet this user works at. Where their sales and receipts land. */
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

// Never let a password hash escape through a JSON response.
userSchema.set("toJSON", {
  transform(_doc, ret: Record<string, unknown>) {
    delete ret.passwordHash;
    return ret;
  },
});

export type UserDoc = InferSchemaType<typeof userSchema>;

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>("User", userSchema);
