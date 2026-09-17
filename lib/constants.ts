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
