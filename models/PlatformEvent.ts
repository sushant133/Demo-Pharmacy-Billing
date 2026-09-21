import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const PLATFORM_ACTIONS = [
  "pharmacy.created",
  "pharmacy.updated",
  "pharmacy.print-template",
  "pharmacy.suspended",
  "pharmacy.activated",
  "pharmacy.deleted",
  "owner.updated",
  "owner.password-reset",
  "branch.created",
  "branch.deleted",
  "backup.downloaded",
  "impersonation.started",
  "impersonation.ended",
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

/**
 * What the platform administrator did, written down.
 *
 * lib/activity-log.ts derives a shop's history from the documents each action
 * left behind, and says plainly what that cannot cover: anything that leaves
 * no document. Every action on this side is exactly that. Suspending a shop
 * flips one boolean, resetting a password overwrites a hash, deleting a
 * pharmacy removes the evidence entirely - so unless it is recorded here, the
 * most consequential actions in the system are the only ones nobody can
 * account for afterwards.
 *
 * Deliberately outside the tenant. These rows are the platform's own record:
 * they are never included in a pharmacy backup, never visible to a shop, and
 * they outlive the pharmacy they describe - a deleted shop must leave behind
 * who deleted it and when.
 */
const platformEventSchema = new Schema(
  {
    action: { type: String, required: true, enum: PLATFORM_ACTIONS, index: true },
    /** The superadmin who did it. Kept by name too, so a deleted account still reads. */
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, trim: true, default: "", maxlength: 120 },
    /**
     * Not a populated ref: the pharmacy may be gone. The name is stored
     * alongside so the row still says which shop it was about.
     */
    pharmacyId: { type: Schema.Types.ObjectId, default: null, index: true },
    pharmacyName: { type: String, trim: true, default: "", maxlength: 160 },
    /** One line, already in the past tense, ready to render. */
    summary: { type: String, trim: true, default: "", maxlength: 400 },
    /** Anything worth keeping that is not in the summary: a reason, a count. */
    detail: { type: String, trim: true, default: "", maxlength: 1000 },
  },
  { timestamps: true },
);

platformEventSchema.index({ createdAt: -1 });

export type PlatformEventDoc = InferSchemaType<typeof platformEventSchema>;

export const PlatformEvent: Model<PlatformEventDoc> =
  (models.PlatformEvent as Model<PlatformEventDoc>) ??
  model<PlatformEventDoc>("PlatformEvent", platformEventSchema);
