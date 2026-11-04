/**
 * Domain enums shared by models, validation schemas and client components.
 *
 * These live outside models/ deliberately. A client component that needs the
 * list of payment modes must not have to import a Mongoose schema to get it -
 * doing so pulls the entire driver into the browser bundle.
 */

export const MEDICINE_UNITS = [
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "ointment",
  "cream",
  "drops",
  "inhaler",
  "sachet",
  "suppository",
  "other",
] as const;
export type MedicineUnit = (typeof MEDICINE_UNITS)[number];

export const MEDICINE_CATEGORIES = [
  "Analgesic",
  "Antibiotic",
  "Antacid",
  "Antihistamine",
  "Antidiabetic",
  "Antihypertensive",
  "Antipyretic",
  "Cardiac",
  "Dermatology",
  "Gastro",
  "Respiratory",
  "Supplement",
  "Ophthalmic",
  "Other",
] as const;
export type MedicineCategory = (typeof MEDICINE_CATEGORIES)[number];

/**
 * Built-in list plus a shop's extra names, with Other always last and no
 * duplicates. Used by the medicine form, the catalogue filter, and Settings.
 */
export function mergeMedicineCategories(extra: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  function push(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  }

  for (const name of MEDICINE_CATEGORIES) {
    if (name === "Other") continue;
    push(name);
  }
  for (const name of extra) {
    if (name.trim().toLowerCase() === "other") continue;
    push(name);
  }
  push("Other");
  return out;
}

/**
 * IRD tax invoices must name the buyer (and their PAN when they have one)
 * for B2B sales and for any bill of this amount or more. Walk-in retail
 * below the threshold may use an abbreviated invoice.
 */
export const IRD_BUYER_DETAIL_THRESHOLD = 5000;

export const PAYMENT_MODES = [
  "cash",
  "card",
  "esewa",
  "khalti",
  "bank",
  "credit",
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  card: "Card",
  esewa: "eSewa",
  khalti: "Khalti",
  bank: "Bank transfer",
  credit: "Credit",
};

// ---------------------------------------------------------------------------
// Purchasing (Phase 2)
// ---------------------------------------------------------------------------

/**
 * A purchase is entered as a `draft`, checked against the physical delivery,
 * then `posted` - which is the moment stock actually exists. `cancelled`
 * reverses a posted GRN when nothing has been sold from it yet.
 */
export const PURCHASE_STATUSES = ["draft", "posted", "cancelled"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  draft: "Draft",
  posted: "Posted",
  cancelled: "Cancelled",
};

export const PAYMENT_STATUSES = ["unpaid", "partial", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
};

/** How money leaves the shop to a supplier. */
export const SUPPLIER_PAYMENT_METHODS = [
  "cash",
  "cheque",
  "bank-transfer",
  "esewa",
  "khalti",
  "adjustment",
] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  cash: "Cash",
  cheque: "Cheque",
  "bank-transfer": "Bank transfer",
  esewa: "eSewa",
  khalti: "Khalti",
  adjustment: "Adjustment",
};

/**
 * Where a medicine sits under the Drugs Act 2035.
 *
 * Over-the-counter and prescription lines differ only by a warning at the till.
 * Narcotic and psychotropic lines are controlled: the sale is refused until the
 * patient, prescriber and prescription are recorded, and every unit in and out
 * appears on the record DDA asks a retailer to keep.
 */
export const MEDICINE_SCHEDULES = ["otc", "rx", "psychotropic", "narcotic"] as const;
export type MedicineSchedule = (typeof MEDICINE_SCHEDULES)[number];

export const MEDICINE_SCHEDULE_LABELS: Record<MedicineSchedule, string> = {
  otc: "Over the counter",
  rx: "Prescription (Rx)",
  psychotropic: "Psychotropic",
  narcotic: "Narcotic",
};

export const CONTROLLED_SCHEDULES: readonly MedicineSchedule[] = ["psychotropic", "narcotic"];

export function isControlledSchedule(schedule: unknown): boolean {
  return schedule === "psychotropic" || schedule === "narcotic";
}

/**
 * A medicine's schedule, read safely from a record that may predate the field.
 * Those only ever carried the Rx flag, so that flag decides between the two
 * uncontrolled schedules.
 */
export function medicineSchedule(medicine: {
  schedule?: unknown;
  requiresPrescription?: unknown;
}): MedicineSchedule {
  if (isControlledSchedule(medicine.schedule)) {
    return medicine.schedule as MedicineSchedule;
  }
  if (medicine.schedule === "rx" || medicine.requiresPrescription) return "rx";
  return "otc";
}

/**
 * Categories a pharmacy sells that are not medicines, and so carry VAT.
 * Schedule 1 of the VAT Act 2052 exempts medicines, not everything on the shelf.
 */
const TAXABLE_CATEGORY = /supplement|cosmetic|nutrition|device|equipment|personal care|baby|food/i;

/**
 * Names that say a product is toiletry, for lines with no category yet, such as
 * those arriving on a supplier's bill. No word boundaries: bills run words
 * together, as in "SOAP75GM" and "FACEWASH".
 */
const TAXABLE_NAME = /soap|face\s*wash|shampoo|conditioner|sunscreen|saniti[sz]er|moisturi[sz]er|toothpaste|mouth\s*wash|lotion|diaper|perfume/i;

/**
 * Whether a new catalogue line starts as VAT exempt. Only a starting point: the
 * shop can change it per item, because the schedule is the shop's to apply.
 */
export function defaultVatExempt(category?: string | null, name?: string | null): boolean {
  return !TAXABLE_CATEGORY.test(category ?? "") && !TAXABLE_NAME.test(name ?? "");
}
