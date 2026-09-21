import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import {
  DEFAULT_PRINT_TEMPLATE,
  PRINT_TEMPLATE_IDS,
} from "@/lib/print-templates";

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
 *
 * Two kinds of field live here, and the difference matters:
 *
 *   - The **registered identity** of the business: trading and registered
 *     names, PAN, VAT number, company registration and drug licence. These
 *     are what a tax invoice must carry, superadmin owns them, and the shop
 *     reads them without being able to edit them. All optional, because an
 *     account is often opened from a phone call and the paperwork follows -
 *     a bill printed before then simply has a gap where the number goes.
 *   - The **platform's own notes**: the owner's phone and citizenship
 *     number, internal notes, who opened the account. The shop never sees
 *     these at all.
 *   - A **seed** for the shop's own settings. The address, city and phone
 *     captured at creation are copied into that pharmacy's Setting record so
 *     its first printed bill is not blank. Those stay the shop's to correct;
 *     the identity fields above do not.
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
    /** Why access was last suspended or restored. Shown beside the badge. */
    statusReason: { type: String, trim: true, default: "", maxlength: 300 },
    statusChangedAt: { type: Date, default: null },

    /**
     * Which bill layout this shop's printer can actually produce.
     *
     * A platform setting rather than a shop one: it describes the hardware
     * on the counter, it is chosen when the account is opened, and getting
     * it wrong means paper that comes out cut in half. The shop still owns
     * everything the bill *says* - its header, terms and footer - on its own
     * Settings screen. See lib/print-templates.ts for the catalogue.
     */
    printTemplate: {
      type: String,
      enum: PRINT_TEMPLATE_IDS,
      default: DEFAULT_PRINT_TEMPLATE,
    },

    // --- The business's registered identity -------------------------------
    /*
      These are what the shop *is*, on paper: the names, tax numbers and
      licences a VAT invoice is legally required to carry. Superadmin owns
      them outright and the pharmacy sees them read-only on its Settings
      screen - a shop correcting its own PAN is a shop that can print a tax
      invoice under a number the platform never verified. `getSettings`
      overlays these onto the shop's record, so the bill header, the PDF and
      every preview read them from here.
    */
    /** Permanent Account Number. Nine digits in Nepal. */
    pan: { type: String, trim: true, default: "", maxlength: 30 },
    /** VAT registration number. In Nepal this is usually the PAN itself. */
    vatNumber: { type: String, trim: true, default: "", maxlength: 30 },
    /** False for a PAN-only business, which leaves VAT off the bill. */
    vatRegistered: { type: Boolean, default: true },
    /** Company or firm registration number. */
    registrationNo: { type: String, trim: true, default: "", maxlength: 60 },
    /** Department of Drug Administration licence. */
    drugLicenceNo: { type: String, trim: true, default: "", maxlength: 60 },
    /** When that licence runs out, so an expiring one can be chased. */
    licenceExpiry: { type: Date, default: null },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    city: { type: String, trim: true, default: "", maxlength: 120 },
    phone: { type: String, trim: true, default: "", maxlength: 40 },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      maxlength: 160,
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
    /** Reachable number for the owner. Not the shop's counter line. */
    ownerPhone: { type: String, trim: true, default: "", maxlength: 40 },
    /**
     * Citizenship number of the person who signed up.
     *
     * Know-your-customer only: it identifies the human behind the account
     * when a licence or a payment is disputed. It never leaves this screen -
     * no bill, no report and no shop user ever sees it.
     */
    ownerCitizenshipNo: { type: String, trim: true, default: "", maxlength: 40 },
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
