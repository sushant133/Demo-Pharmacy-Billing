import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * The shop's own identity, as one editable record.
 *
 * These details used to live only in environment variables, which meant the
 * name and PAN printed on a tax invoice could not be corrected without a
 * redeploy - a poor arrangement for a field that is legally required to be
 * right. They now live here, where an admin can fix them from the Settings
 * screen.
 *
 * A single document, pinned by `key`. A unique index on a constant field is
 * the cheap way to make "there is exactly one of these" a database rule rather
 * than a convention two concurrent writers can break.
 *
 * A branch may still override the name, address, phone and PAN it prints: a
 * Nepali VAT invoice must carry the issuing outlet's own identity, not head
 * office's. This record is what an outlet falls back to, and what a
 * single-shop pharmacy - almost all of them - uses directly.
 */
const settingSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    /** Always "business". The unique index with pharmacyId enforces one record per shop. */
    key: { type: String, required: true, default: "business" },

    // --- Identity ---------------------------------------------------------
    /** Trading name, printed at the head of every bill. */
    businessName: { type: String, required: true, trim: true, maxlength: 160 },
    /** Registered name, when it differs from the trading name. */
    legalName: { type: String, trim: true, default: "", maxlength: 160 },

    // --- Tax registration -------------------------------------------------
    /** Permanent Account Number. A tax invoice without it is not valid. */
    pan: { type: String, trim: true, default: "", maxlength: 30 },
    /** True once the shop is VAT registered rather than PAN-only. */
    vatRegistered: { type: Boolean, default: true },
    /** VAT registration number. In Nepal this is usually the PAN itself. */
    vatNumber: { type: String, trim: true, default: "", maxlength: 30 },
    /** Stored as a fraction: 0.13 is 13%. */
    vatRate: { type: Number, default: 0.13, min: 0, max: 1 },

    // --- Licences ---------------------------------------------------------
    /** Department of Drug Administration licence. */
    drugLicenceNo: { type: String, trim: true, default: "", maxlength: 60 },
    /** Company or firm registration number. */
    registrationNo: { type: String, trim: true, default: "", maxlength: 60 },

    // --- Contact ----------------------------------------------------------
    address: { type: String, trim: true, default: "", maxlength: 300 },
    city: { type: String, trim: true, default: "", maxlength: 120 },
    phone: { type: String, trim: true, default: "", maxlength: 40 },
    altPhone: { type: String, trim: true, default: "", maxlength: 40 },
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
    website: { type: String, trim: true, default: "", maxlength: 160 },

    // --- What the bill says -----------------------------------------------
    /** Terms line above the signature. Returns policy, usually. */
    billTerms: { type: String, trim: true, default: "", maxlength: 400 },
    /** The closing line. "Thank you", or whatever the shop prefers. */
    billFooterNote: { type: String, trim: true, default: "", maxlength: 400 },

    /** Extra medicine categories on top of the built-in list. */
    medicineCategories: { type: [String], default: [] },
  },
  { timestamps: true },
);

settingSchema.index({ pharmacyId: 1, key: 1 }, { unique: true });

export type SettingDoc = InferSchemaType<typeof settingSchema>;

export const Setting: Model<SettingDoc> =
  (models.Setting as Model<SettingDoc>) ?? model<SettingDoc>("Setting", settingSchema);
