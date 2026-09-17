import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A doctor's prescription, and what has been handed over against it.
 *
 * A sale records what left the shelf; this records what was *asked for*, by
 * whom, for whom, and how long the asking stays valid. The two are separate on
 * purpose: one script is dispensed across several visits, a bill covers items
 * from no script at all, and collapsing them would make both unreadable.
 *
 * Dispensing is append-only, like a bill's payments and a sale's returns. The
 * per-line `quantityDispensed` is a running total of the entries below it,
 * never an edited figure, so how a script got to where it is stays readable -
 * and a mistake is corrected by another entry rather than by rewriting the
 * record a pharmacist may have to defend to an inspector.
 */

const prescriptionItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    /** Denormalised, so a script still reads after a catalogue rename. */
    medicineName: { type: String, required: true },
    /** What the prescriber wrote, verbatim: "1-0-1 after food, 5 days". */
    dosage: { type: String, trim: true, default: "", maxlength: 200 },
    quantityPrescribed: { type: Number, required: true, min: 1 },
    /** Running total of the dispense entries below. Never edited directly. */
    quantityDispensed: { type: Number, required: true, min: 0, default: 0 },
    /** Whether the catalogue marks this one prescription-only. */
    requiresPrescription: { type: Boolean, default: false },
    notes: { type: String, trim: true, default: "", maxlength: 300 },
  },
  { _id: false },
);

/** One hand-over against the script. */
const dispenseEntrySchema = new Schema(
  {
    dispensedAt: { type: Date, required: true },
    dispensedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    dispensedByName: { type: String, default: "" },
    /** The bill it went out on, when it was rung up at the till. */
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", default: null },
    billNo: { type: String, trim: true, default: "" },
    items: {
      type: [
        new Schema(
          {
            lineIndex: { type: Number, required: true, min: 0 },
            medicineName: { type: String, required: true },
            quantity: { type: Number, required: true, min: 1 },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
    units: { type: Number, required: true, min: 1 },
    note: { type: String, trim: true, default: "", maxlength: 300 },
  },
  { _id: false },
);

const prescriptionSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    branchName: { type: String, default: "" },

    /** Human-facing number, unique per pharmacy: RX-000042. */
    rxNo: { type: String, required: true, index: true },

    // --- Who it is for ----------------------------------------------------
    //
    // A saved customer where there is one, so a patient's scripts can be read
    // back together; a typed name where there is not, because a script is
    // often written for somebody the shop has never billed.
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    patientName: { type: String, required: true, trim: true, maxlength: 160 },
    patientPhone: { type: String, trim: true, default: "", maxlength: 30 },
    /** Free text: "34", "8 months". Age on a script is not always in years. */
    patientAge: { type: String, trim: true, default: "", maxlength: 30 },
    patientGender: {
      type: String,
      enum: ["", "male", "female", "other"],
      default: "",
    },

    // --- Who wrote it -----------------------------------------------------
    doctorName: { type: String, required: true, trim: true, maxlength: 160 },
    /** NMC registration number. What makes a prescriber checkable. */
    doctorRegNo: { type: String, trim: true, default: "", maxlength: 60 },
    hospital: { type: String, trim: true, default: "", maxlength: 160 },

    /** The date on the script, which is not the date it was filed here. */
    issuedOn: { type: Date, required: true },
    /** Past this, it may not be dispensed against. Null means no expiry. */
    validUntil: { type: Date, default: null },

    items: {
      type: [prescriptionItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: "A prescription must list at least one medicine.",
      },
    },

    dispenses: { type: [dispenseEntrySchema], default: [] },

    /**
     * Sums across `items`, kept in step on every write.
     *
     * Stored rather than derived because the status of a script depends on
     * them, and the list filter has to be able to ask "show me everything
     * still outstanding" without reading every document and summing an array
     * in application code. The same reason `paymentStatus` is stored on a sale.
     */
    prescribedUnits: { type: Number, required: true, min: 0, default: 0 },
    dispensedUnits: { type: Number, required: true, min: 0, default: 0 },
    outstandingUnits: { type: Number, required: true, min: 0, default: 0, index: true },

    /**
     * Whether a physical copy is held.
     *
     * A flag, not a file. Storing scans needs somewhere to put them and a
     * retention rule, and claiming to hold a document that is actually sitting
     * in a drawer would be worse than saying plainly that it is in the drawer.
     */
    copyHeld: { type: Boolean, default: false },
    notes: { type: String, trim: true, default: "", maxlength: 1000 },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelledByName: { type: String, default: "" },
    cancelReason: { type: String, trim: true, default: "", maxlength: 300 },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

// Rx numbers are unique per pharmacy, not globally: two shops both start at 1.
prescriptionSchema.index({ pharmacyId: 1, rxNo: 1 }, { unique: true });
// The list reads newest-first within a branch scope.
prescriptionSchema.index({ pharmacyId: 1, createdAt: -1 });
prescriptionSchema.index({ branchId: 1, createdAt: -1 });
// "What is still owed to this patient?" - the status filter's hot path.
prescriptionSchema.index({ pharmacyId: 1, outstandingUnits: 1, validUntil: 1 });
prescriptionSchema.index({ customerId: 1, createdAt: -1 });
// Free-text search across the three names somebody looks a script up by.
prescriptionSchema.index({
  patientName: "text",
  doctorName: "text",
  "items.medicineName": "text",
});

export type PrescriptionDoc = InferSchemaType<typeof prescriptionSchema>;

export const Prescription: Model<PrescriptionDoc> =
  (models.Prescription as Model<PrescriptionDoc>) ??
  model<PrescriptionDoc>("Prescription", prescriptionSchema);
