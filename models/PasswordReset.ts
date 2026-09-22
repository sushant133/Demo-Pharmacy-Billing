import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A pending password reset.
 *
 * The token is stored **hashed**, exactly as a password is. The row is a
 * bearer credential: anyone holding the raw token can take over the account
 * it points at, so a leaked database dump must not hand over working reset
 * links for every outstanding request. Only the emailed copy is usable, and
 * only until it is spent.
 *
 * Single use and short lived. `usedAt` is stamped the moment a reset goes
 * through, and the TTL index has Mongo remove the row once it expires - so
 * the collection does not grow without bound and an abandoned request cannot
 * sit around being valid.
 */
const passwordResetSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** SHA-256 of the token that was emailed. Never the token itself. */
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    /** Set when the reset is completed. A row with this set is spent. */
    usedAt: { type: Date, default: null },
    /**
     * Where the request came from, for reading an abuse pattern afterwards.
     * Best effort: behind a proxy this is whatever the proxy admitted to.
     */
    requestedIp: { type: String, trim: true, default: "", maxlength: 60 },
  },
  { timestamps: true },
);

/*
  Mongo sweeps expired rows itself. `expireAfterSeconds: 0` means "delete
  once the date in this field has passed", rather than a fixed age - so the
  lifetime is decided when the row is written, in one place.

  The sweep runs about once a minute, so a row can outlive its expiry by up
  to that long. Nothing depends on the sweep for correctness: every read
  checks `expiresAt` itself.
*/
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PasswordResetDoc = InferSchemaType<typeof passwordResetSchema>;

export const PasswordReset: Model<PasswordResetDoc> =
  (models.PasswordReset as Model<PasswordResetDoc>) ??
  model<PasswordResetDoc>("PasswordReset", passwordResetSchema);
