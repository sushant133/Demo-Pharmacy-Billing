/**
 * The vocabulary of stock movement.
 *
 * Kept free of Node-only imports, like lib/roles.ts and for the same reason:
 * the model, the API, the server screens and the browser forms all need these
 * words, and a second list anywhere would be a list that drifts.
 */

export const MOVEMENT_KINDS = [
  /** Units in from a posted purchase. Derived from the GRN, not written here. */
  "purchase",
  /** Units in because a customer brought them back. Derived from the bill. */
  "sale-return",
  /** Units out on a bill. Derived from the sale, not written here. */
  "sale",
  /** Units back to the supplier. Derived from the GRN, not written here. */
  "purchase-return",
  /** A stock-take correction, either way. */
  "adjustment",
  /** Units destroyed, spoiled or expired off the shelf. */
  "damage",
  "transfer-in",
  "transfer-out",
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export type MovementDirection = "in" | "out";

export const MOVEMENT_DIRECTION: Record<MovementKind, MovementDirection> = {
  purchase: "in",
  "sale-return": "in",
  "transfer-in": "in",
  sale: "out",
  "purchase-return": "out",
  damage: "out",
  "transfer-out": "out",
  // An adjustment goes whichever way the count was wrong. The caller decides
  // and stores it; this map is only the default for the fixed kinds.
  adjustment: "in",
};

export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
  purchase: "Purchase received",
  "sale-return": "Customer return",
  sale: "Dispensed on a bill",
  "purchase-return": "Returned to supplier",
  adjustment: "Stock adjustment",
  damage: "Written off",
  "transfer-in": "Transfer in",
  "transfer-out": "Transfer out",
};

/**
 * Why a count was corrected, or why units were written off.
 *
 * A free-text box alone produces a ledger nobody can total; a fixed list alone
 * cannot describe the case nobody predicted. Both: a code to group by, and a
 * sentence to explain the one that does not fit.
 */
export const MOVEMENT_REASONS = [
  // Adjustments
  "stock-take",
  "miscount",
  "found",
  "data-entry",
  // Write-offs
  "expired",
  "damaged",
  "broken",
  "cold-chain",
  "recalled",
  "lost",
  // Either
  "other",
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

export const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  "stock-take": "Physical stock-take",
  miscount: "Miscounted earlier",
  found: "Found unrecorded stock",
  "data-entry": "Data entry error",
  expired: "Expired",
  damaged: "Damaged or spoiled",
  broken: "Broken in handling",
  "cold-chain": "Cold-chain failure",
  recalled: "Recalled by the manufacturer",
  lost: "Lost or stolen",
  other: "Other",
};

/** The reasons offered when correcting a count. */
export const ADJUSTMENT_REASONS = [
  "stock-take",
  "miscount",
  "found",
  "data-entry",
  "other",
] as const satisfies readonly MovementReason[];

/** The reasons offered when taking units off the shelf for good. */
export const WRITE_OFF_REASONS = [
  "expired",
  "damaged",
  "broken",
  "cold-chain",
  "recalled",
  "lost",
  "other",
] as const satisfies readonly MovementReason[];

export function isMovementReason(value: unknown): value is MovementReason {
  return (
    typeof value === "string" &&
    (MOVEMENT_REASONS as readonly string[]).includes(value)
  );
}
