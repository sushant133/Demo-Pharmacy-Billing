import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * One document waiting to reach - or already accepted by - IRD's Central
 * Billing Monitoring System.
 *
 * Every sales invoice, sales return (credit note) and cancellation gets a row,
 * written in the same transaction as the bill itself. That is what makes the
 * queue trustworthy: a bill cannot exist without its row, so nothing is lost
 * if the server stops between saving a bill and sending it. The send happens
 * straight after the sale commits, and anything that does not get through is
 * picked up again by the retry runner (lib/cbms.ts).
 *
 * Not audited through the plugin: these rows change on every attempt and say
 * nothing about what anyone did. The bill's own `cbms` fields, which are
 * audited, carry the outcome.
 */

export const CBMS_KINDS = ["bill", "return", "cancel"] as const;
export type CbmsKind = (typeof CBMS_KINDS)[number];

export const CBMS_STATUSES = ["pending", "synced", "failed", "disabled"] as const;
export type CbmsStatus = (typeof CBMS_STATUSES)[number];

const cbmsSyncSchema = new Schema(
  {
    pharmacyId: { type: Schema.Types.ObjectId, ref: "Pharmacy", required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true, index: true },
    kind: { type: String, enum: CBMS_KINDS, required: true },
    /** For a return: its position in the bill's `returns`. */
    returnIndex: { type: Number, default: null },
    /** The bill or credit note number this row reports, for the screen. */
    documentNo: { type: String, required: true },
    /** When the document was issued; the order rows are sent in. */
    issuedAt: { type: Date, required: true },

    status: { type: String, enum: CBMS_STATUSES, required: true, default: "pending" },
    attempts: { type: Number, required: true, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: () => new Date() },
    /** A send is in flight until this time. Even a forced send respects it. */
    leaseUntil: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
    /** CBMS's answer: 200 accepted, 101 already exists, 100 bad credentials... */
    responseCode: { type: Number, default: null },
    responseMessage: { type: String, default: "" },
  },
  { timestamps: true },
);

// The retry runner's read: everything still owed to IRD, oldest first.
cbmsSyncSchema.index({ status: 1, nextAttemptAt: 1 });
cbmsSyncSchema.index({ pharmacyId: 1, status: 1, issuedAt: 1 });
// One row per document: a retried transaction must not queue a bill twice.
cbmsSyncSchema.index({ saleId: 1, kind: 1, returnIndex: 1 }, { unique: true });

export type CbmsSyncDoc = InferSchemaType<typeof cbmsSyncSchema>;

export const CbmsSync: Model<CbmsSyncDoc> =
  (models.CbmsSync as Model<CbmsSyncDoc>) ??
  model<CbmsSyncDoc>("CbmsSync", cbmsSyncSchema);
