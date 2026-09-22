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
     * Which role scheme `role` was written under.
     *
     * Deliberately has no schema default: a default is applied on create, so
     * every row written from here on records 2, while rows that predate
     * narrower roles keep reading back as undefined. That absence is the
     * signal - it is what tells `normalizeRole` that a stored "pharmacist"
     * meant the owner rather than a pharmacist. Backfilling it would erase
     * the distinction, so `scripts/migrate-roles.ts` resolves those rows to
     * an explicit role instead.
     */
    roleVersion: { type: Number, default: undefined },
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
    /**
     * When the password was last changed, by a reset or by the owner.
     *
     * Recorded rather than used: sessions are stateless JWTs verified without
     * a database read, so nothing compares a token's issue time against this
     * yet. It is here so that check can be added without a migration, and
     * because "when did this password last change" is worth being able to
     * answer on its own. See lib/password-reset.ts.
     */
    passwordChangedAt: { type: Date, default: null },
    /**
     * The password was issued by somebody else - generated when the platform
     * opened the pharmacy, or set by superadmin on a reset - and has been
     * through a mailbox. Until the owner chooses their own, middleware keeps
     * them on /change-password. Cleared by any password the user sets
     * themselves, including through a reset link.
     */
    mustChangePassword: { type: Boolean, default: false },
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
