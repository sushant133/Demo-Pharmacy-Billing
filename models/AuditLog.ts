import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * The audit trail: one entry per change to a business record, and per
 * security event (sign-in, failed sign-in, sign-out).
 *
 * Append-only. Every update and delete path on this model throws, so nothing
 * in the application - including an owner or the platform admin - can edit or
 * remove an entry. Each entry also carries an HMAC of its own contents, signed
 * with a server-side key, so an edit made directly in the database (outside
 * the app) shows up as a failed signature on the audit screen.
 *
 * Written inside the same transaction as the change it describes, so a change
 * that rolls back leaves no entry, and one that commits always has one.
 */

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "login",
  "login-failed",
  "logout",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const auditChangeSchema = new Schema(
  {
    path: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const auditLogSchema = new Schema(
  {
    /** Null for platform-level events (superadmin, failed sign-in by unknown email). */
    pharmacyId: { type: Schema.Types.ObjectId, ref: "Pharmacy", default: null, index: true },
    at: { type: Date, required: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    /** Model name, e.g. "Sale". Blank for security events. */
    entity: { type: String, default: "" },
    entityId: { type: String, default: "" },
    /** Human handle for the record: a bill number, a medicine name. */
    label: { type: String, default: "" },
    changes: { type: [auditChangeSchema], default: [] },

    actorId: { type: String, default: "" },
    actorName: { type: String, default: "System" },
    actorRole: { type: String, default: "" },
    /** Set when a platform admin was signed in as this user. */
    impersonatorName: { type: String, default: "" },
    method: { type: String, default: "" },
    path: { type: String, default: "" },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    /** Free text for security events, e.g. the email a failed sign-in tried. */
    note: { type: String, default: "" },

    /** HMAC-SHA256 over the fields above. See lib/audit.ts. */
    signature: { type: String, required: true },
  },
  // No `timestamps`: `updatedAt` would suggest an entry can change.
  { versionKey: false },
);

auditLogSchema.index({ pharmacyId: 1, at: -1 });
auditLogSchema.index({ pharmacyId: 1, entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ pharmacyId: 1, actorId: 1, at: -1 });

function refuse(): never {
  throw new Error("The audit log is append-only. Entries cannot be changed or removed.");
}

for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  auditLogSchema.pre(op, refuse);
}
auditLogSchema.pre("deleteOne", { document: true, query: false }, refuse);
auditLogSchema.pre("save", function () {
  if (!this.isNew) refuse();
});
auditLogSchema.pre("bulkWrite", refuse);

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ??
  model<AuditLogDoc>("AuditLog", auditLogSchema);
