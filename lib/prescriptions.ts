import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { branchForWrite } from "@/lib/branches";
import { connectDB } from "@/lib/db";
import {
  prescriptionStatus,
  remainingOnLine,
  type PrescriptionStatus,
} from "@/lib/prescription-status";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { pharmacyFilter } from "@/lib/tenant";
import { Customer } from "@/models/Customer";
import { Medicine } from "@/models/Medicine";
import { nextSequence } from "@/models/Counter";
import { Prescription } from "@/models/Prescription";
import type { SessionUser } from "@/lib/session";
import type {
  DispensePrescriptionInput,
  PrescriptionInput,
} from "@/lib/validation";

/**
 * Filing prescriptions, and dispensing against them.
 *
 * The rules this enforces are the ones a pharmacist would be asked about:
 *
 *   - nothing is dispensed against a cancelled or expired script
 *   - nothing is dispensed beyond what was actually prescribed
 *   - every hand-over is appended, never merged into a running figure
 *
 * Checked here rather than only in the form, because the form is a
 * convenience and this is the record. Concurrency is guarded the way the rest
 * of the system guards it: the write is conditional on the dispensed totals
 * the check was made against, so two counters cannot both hand over the last
 * of a script.
 */

export interface PrescriptionSummary {
  id: string;
  rxNo: string;
  patientName: string;
  doctorName: string;
  status: PrescriptionStatus;
  prescribedUnits: number;
  dispensedUnits: number;
  outstandingUnits: number;
}

/** Rx numbers run per pharmacy, so two shops both start at RX-000001. */
function rxKey(pharmacyId: string): string {
  return `rx:${pharmacyId}`;
}

function formatRxNo(seq: number): string {
  return `RX-${String(seq).padStart(6, "0")}`;
}

function summarise(doc: {
  _id: unknown;
  rxNo: string;
  patientName: string;
  doctorName: string;
  prescribedUnits: number;
  dispensedUnits: number;
  outstandingUnits: number;
  items: ReadonlyArray<{ quantityPrescribed: number; quantityDispensed: number }>;
  validUntil?: Date | null;
  cancelledAt?: Date | null;
}): PrescriptionSummary {
  return {
    id: String(doc._id),
    rxNo: doc.rxNo,
    patientName: doc.patientName,
    doctorName: doc.doctorName,
    status: prescriptionStatus(doc).status,
    prescribedUnits: doc.prescribedUnits,
    dispensedUnits: doc.dispensedUnits,
    outstandingUnits: doc.outstandingUnits,
  };
}

/**
 * File a new prescription.
 *
 * Medicine names are copied onto the script at the moment it is filed, the
 * same way a bill freezes them: a script reprinted next year must show what
 * was actually prescribed, even if the catalogue has since been renamed.
 */
export async function createPrescription(
  user: SessionUser,
  input: PrescriptionInput,
): Promise<PrescriptionSummary> {
  await connectDB();

  const medicines = await Medicine.find({
    _id: { $in: input.items.map((item) => item.medicineId) },
    ...pharmacyFilter(user),
  })
    .select("name requiresPrescription")
    .lean();

  const byId = new Map(medicines.map((doc) => [String(doc._id), doc]));

  const missing = input.items.find((item) => !byId.has(item.medicineId));
  if (missing) {
    throw ApiError.badRequest(
      "One of the medicines on this prescription is no longer in the catalogue.",
    );
  }

  const items = input.items.map((item) => {
    const medicine = byId.get(item.medicineId)!;
    return {
      medicineId: new Types.ObjectId(item.medicineId),
      medicineName: medicine.name,
      dosage: item.dosage,
      quantityPrescribed: item.quantityPrescribed,
      quantityDispensed: 0,
      requiresPrescription: Boolean(medicine.requiresPrescription),
      notes: item.notes,
    };
  });

  const prescribedUnits = items.reduce(
    (sum, item) => sum + item.quantityPrescribed,
    0,
  );

  // A saved customer's details are copied onto the script rather than looked
  // up later, so it still reads if the customer record is edited afterwards.
  let customerId: Types.ObjectId | null = null;
  let patientName = input.patientName;
  let patientPhone = input.patientPhone;

  if (input.customerId) {
    const customer = await Customer.findOne({
      _id: input.customerId,
      ...pharmacyFilter(user),
    })
      .select("name phone")
      .lean();
    if (customer) {
      customerId = customer._id;
      patientName = input.patientName || customer.name;
      patientPhone = input.patientPhone || customer.phone || "";
    }
  }

  const branch = await branchForWrite(user);

  return withTransaction(async ({ session }) => {
    const seq = await nextSequence(rxKey(user.pharmacyId), session, async () => {
      // A restored backup can hold scripts whose counter is gone. Starting at
      // 1 would hand out a number that already exists and fail on the unique
      // index, so the sequence is seeded from the records themselves.
      const latest = await Prescription.findOne(pharmacyFilter(user))
        .sort({ createdAt: -1 })
        .select("rxNo")
        .session(session)
        .lean();
      const digits = latest?.rxNo?.match(/(\d+)\s*$/)?.[1];
      return digits ? Number(digits) : 0;
    });

    const [created] = await Prescription.create(
      [
        {
          ...pharmacyFilter(user),
          branchId: branch.id,
          branchName: branch.name,
          rxNo: formatRxNo(seq),
          customerId,
          patientName,
          patientPhone,
          patientAge: input.patientAge,
          patientGender: input.patientGender,
          doctorName: input.doctorName,
          doctorRegNo: input.doctorRegNo,
          hospital: input.hospital,
          issuedOn: input.issuedOn,
          validUntil: input.validUntil,
          items,
          prescribedUnits,
          dispensedUnits: 0,
          outstandingUnits: prescribedUnits,
          copyHeld: input.copyHeld,
          notes: input.notes,
          createdBy: new Types.ObjectId(user.id),
          createdByName: user.name,
        },
      ],
      sessionOption(session),
    );

    if (!created) throw new Error("The prescription was not created.");
    return summarise(created.toObject());
  });
}

/**
 * Hand part or all of a script over.
 *
 * Every line is checked against what is still outstanding before anything is
 * written, and the write is conditional on the dispensed totals those checks
 * were made against - so a script that another counter has just finished
 * cannot be dispensed twice.
 */
export async function dispensePrescription(
  user: SessionUser,
  id: string,
  input: DispensePrescriptionInput,
): Promise<PrescriptionSummary> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const script = await Prescription.findOne({
      _id: id,
      ...pharmacyFilter(user),
    })
      .session(session)
      .lean();

    if (!script) throw ApiError.notFound("That prescription no longer exists.");

    const state = prescriptionStatus(script);
    if (!state.dispensable) {
      throw ApiError.conflict(
        state.status === "cancelled"
          ? `${script.rxNo} was cancelled, so nothing can be dispensed against it.`
          : state.status === "expired"
            ? `${script.rxNo} expired on ${new Date(script.validUntil!).toDateString()} and cannot be dispensed against.`
            : `${script.rxNo} has already been dispensed in full.`,
      );
    }

    // Two entries for the same line in one submission would each pass a check
    // the other invalidates, so they are merged before anything is validated.
    const wanted = new Map<number, number>();
    for (const item of input.items) {
      wanted.set(item.lineIndex, (wanted.get(item.lineIndex) ?? 0) + item.quantity);
    }

    const entryItems: Array<{
      lineIndex: number;
      medicineName: string;
      quantity: number;
    }> = [];
    const nextQuantities = script.items.map((line) => line.quantityDispensed);

    for (const [lineIndex, quantity] of wanted) {
      const line = script.items[lineIndex];
      if (!line) {
        throw ApiError.badRequest("That item is not on this prescription.");
      }

      const remaining = remainingOnLine(line);
      if (remaining === 0) {
        throw ApiError.badRequest(
          `${line.medicineName} has already been dispensed in full.`,
        );
      }
      if (quantity > remaining) {
        throw ApiError.badRequest(
          `Only ${remaining} of ${line.medicineName} is still outstanding on ${script.rxNo}.`,
        );
      }

      nextQuantities[lineIndex] = line.quantityDispensed + quantity;
      entryItems.push({
        lineIndex,
        medicineName: line.medicineName,
        quantity,
      });
    }

    const units = entryItems.reduce((sum, item) => sum + item.quantity, 0);
    const dispensedUnits = script.dispensedUnits + units;
    const outstandingUnits = Math.max(0, script.prescribedUnits - dispensedUnits);

    const updated = await Prescription.findOneAndUpdate(
      {
        _id: id,
        ...pharmacyFilter(user),
        cancelledAt: null,
        // The totals this was computed against. If another counter dispensed
        // in the meantime, this matches nothing and the write is refused
        // rather than overwriting their entry.
        dispensedUnits: script.dispensedUnits,
      },
      {
        $set: {
          dispensedUnits,
          outstandingUnits,
          ...Object.fromEntries(
            nextQuantities.map((quantity, index) => [
              `items.${index}.quantityDispensed`,
              quantity,
            ]),
          ),
        },
        $push: {
          dispenses: {
            dispensedAt: new Date(),
            dispensedBy: new Types.ObjectId(user.id),
            dispensedByName: user.name,
            billNo: input.billNo ?? "",
            items: entryItems,
            units,
            note: input.note ?? "",
          },
        },
      },
      { new: true, ...sessionOption(session) },
    );

    if (!updated) {
      throw ApiError.conflict(
        `Another counter dispensed against ${script.rxNo} a moment ago. Open it again and check what is left.`,
      );
    }

    onRollback(() =>
      Prescription.updateOne(
        { _id: id },
        {
          $set: {
            dispensedUnits: script.dispensedUnits,
            outstandingUnits: script.outstandingUnits,
            ...Object.fromEntries(
              script.items.map((line, index) => [
                `items.${index}.quantityDispensed`,
                line.quantityDispensed,
              ]),
            ),
          },
          $pop: { dispenses: 1 },
        },
      ).exec(),
    );

    return summarise(updated);
  });
}

/**
 * Withdraw a script.
 *
 * Cancelled rather than deleted: the number was issued, and a script that was
 * partly dispensed and then withdrawn is exactly the case an inspector asks
 * about. What was handed over stays on the record.
 */
export async function cancelPrescription(
  user: SessionUser,
  id: string,
  reason: string,
): Promise<PrescriptionSummary> {
  await connectDB();

  const updated = await Prescription.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user), cancelledAt: null },
    {
      $set: {
        cancelledAt: new Date(),
        cancelledBy: new Types.ObjectId(user.id),
        cancelledByName: user.name,
        cancelReason: reason,
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const exists = await Prescription.exists({ _id: id, ...pharmacyFilter(user) });
    throw exists
      ? ApiError.conflict("That prescription has already been cancelled.")
      : ApiError.notFound("That prescription no longer exists.");
  }

  return summarise(updated);
}
