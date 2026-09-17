import { startOfLocalDay, toDateInputValue } from "@/lib/dates";

/**
 * One word for the state a prescription is in.
 *
 * A prescription carries three independent facts - was it cancelled, has it
 * run out of validity, and how much of it has been handed over - and a list
 * showing all three at once is a list nobody scans. This collapses them into
 * the single answer a counter actually wants, with a deliberate order of
 * precedence:
 *
 *   1. Cancelled - withdrawn. Nothing else about it matters any more.
 *   2. Dispensed - everything on it has been handed over. Expiry is moot.
 *   3. Expired   - past its validity with something still outstanding. It
 *                  cannot be dispensed against, whatever is left on it.
 *   4. Partial   - some handed over, more still owed, still in date.
 *   5. Active    - nothing dispensed yet, still in date.
 *
 * Pure and tested, like lib/sale-status.ts and for the same reason: "may I
 * hand this over?" is not a question to get wrong, and the same rule has to
 * drive both the badge and the filter that claims to find those badges.
 */

export const PRESCRIPTION_STATUSES = [
  "active",
  "partial",
  "dispensed",
  "expired",
  "cancelled",
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export type BadgeTone = "slate" | "brand" | "green" | "amber" | "rose";

export const PRESCRIPTION_STATUS_LABELS: Record<PrescriptionStatus, string> = {
  active: "Active",
  partial: "Part dispensed",
  dispensed: "Fully dispensed",
  expired: "Expired",
  cancelled: "Cancelled",
};

export interface PrescriptionLine {
  quantityPrescribed: number;
  quantityDispensed: number;
}

export interface PrescriptionRecord {
  items: ReadonlyArray<PrescriptionLine>;
  /** Past this date it may not be dispensed against. Null means no expiry. */
  validUntil?: Date | string | null;
  cancelledAt?: Date | string | null;
}

export interface PrescriptionStatusView {
  status: PrescriptionStatus;
  label: string;
  tone: BadgeTone;
  /** Units still owed across every line. Zero once nothing is outstanding. */
  outstanding: number;
  /** Whether the counter may hand anything over against it right now. */
  dispensable: boolean;
}

/** Units still to hand over on one line. Never negative. */
export function remainingOnLine(line: PrescriptionLine): number {
  return Math.max(0, line.quantityPrescribed - line.quantityDispensed);
}

export function outstandingUnits(record: PrescriptionRecord): number {
  return record.items.reduce((sum, line) => sum + remainingOnLine(line), 0);
}

/**
 * Whether a prescription has run out of validity.
 *
 * Compared as calendar dates, not as instants: a script valid until the 14th
 * is valid all day on the 14th, which is how a patient and a pharmacist both
 * read it. Comparing raw timestamps would refuse it from midnight and turn a
 * valid script into an argument at the counter.
 *
 * The comparison is made in the shop's timezone. `setHours` would have used
 * the server's, which is a different day for the hours when Kathmandu and a
 * VPS disagree on the date - and "is this script still good?" answered
 * differently depending on where the machine sits is not an answer at all.
 */
export function isExpiredOn(
  validUntil: Date | string | null | undefined,
  asOf: Date = new Date(),
): boolean {
  if (!validUntil) return false;
  const end = validUntil instanceof Date ? validUntil : new Date(validUntil);
  if (Number.isNaN(end.getTime())) return false;
  // YYYY-MM-DD in the business timezone, so a lexicographic compare is a
  // calendar compare.
  return toDateInputValue(asOf) > toDateInputValue(end);
}

export function prescriptionStatus(
  record: PrescriptionRecord,
  asOf: Date = new Date(),
): PrescriptionStatusView {
  if (record.cancelledAt) {
    return {
      status: "cancelled",
      label: "Cancelled",
      tone: "rose",
      outstanding: 0,
      dispensable: false,
    };
  }

  const outstanding = outstandingUnits(record);

  // Everything asked for has been handed over. A script that ran to completion
  // before it lapsed is finished, not expired - the date stopped mattering.
  if (outstanding === 0 && record.items.length > 0) {
    return {
      status: "dispensed",
      label: "Fully dispensed",
      tone: "green",
      outstanding: 0,
      dispensable: false,
    };
  }

  if (isExpiredOn(record.validUntil, asOf)) {
    return {
      status: "expired",
      label: "Expired",
      tone: "slate",
      outstanding,
      dispensable: false,
    };
  }

  const dispensed = record.items.some((line) => line.quantityDispensed > 0);
  if (dispensed) {
    return {
      status: "partial",
      label: "Part dispensed",
      tone: "amber",
      outstanding,
      dispensable: true,
    };
  }

  return {
    status: "active",
    label: "Active",
    tone: "brand",
    outstanding,
    dispensable: true,
  };
}

/**
 * The same rule as a Mongo filter, so the dropdown finds exactly the rows the
 * badges show. Kept beside `prescriptionStatus` precisely so the two cannot
 * drift.
 *
 * `outstandingUnits` is stored on the document for this reason: the status
 * depends on a sum across an array, and a filter that had to compute it would
 * either scan every prescription or quietly disagree with the badge.
 */
export function prescriptionStatusFilter(
  status: PrescriptionStatus,
  asOf: Date = new Date(),
): Record<string, unknown> {
  const live = { cancelledAt: null };
  /*
    Midnight today, in the shop's timezone.

    Must match `isExpiredOn` exactly or the dropdown returns rows the badge
    disagrees with - which is the whole reason these two live side by side.
    `startOfLocalDay` resolves the business timezone; `new Date().setHours(0)`
    would resolve the server's, and the two are a different day for the hours
    when Kathmandu and a VPS disagree on the date.

    A script valid *today* is still valid, so today's midnight is the boundary:
    `>=` keeps it, `<` has lapsed.
  */
  const startOfToday = startOfLocalDay(asOf);

  const inDate = {
    $or: [{ validUntil: null }, { validUntil: { $gte: startOfToday } }],
  };
  const lapsed = { validUntil: { $ne: null, $lt: startOfToday } };

  switch (status) {
    case "cancelled":
      return { cancelledAt: { $ne: null } };
    case "dispensed":
      return { ...live, outstandingUnits: 0 };
    case "expired":
      return { ...live, outstandingUnits: { $gt: 0 }, ...lapsed };
    case "partial":
      return {
        ...live,
        outstandingUnits: { $gt: 0 },
        dispensedUnits: { $gt: 0 },
        ...inDate,
      };
    case "active":
      return {
        ...live,
        outstandingUnits: { $gt: 0 },
        dispensedUnits: 0,
        ...inDate,
      };
  }
}

export function isPrescriptionStatus(value: unknown): value is PrescriptionStatus {
  return (
    typeof value === "string" &&
    (PRESCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}
