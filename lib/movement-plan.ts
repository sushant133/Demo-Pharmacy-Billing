import type { MovementDirection } from "@/lib/movement-kinds";

/**
 * What a stock movement would do, worked out before anything is written.
 *
 * Pure, like lib/fefo.ts and lib/sale-payment.ts, and for the same reason:
 * this is the arithmetic that decides whether units disappear off a shelf.
 * Getting the sign wrong on an adjustment turns a stock-take that found two
 * extra boxes into one that destroyed two, and nothing downstream would say so
 * - the count would simply be wrong from then on.
 *
 * Nothing here touches the database. The services re-check against the live
 * count under a guarded update, because between planning and writing somebody
 * at the till may have sold the last box; this decides only what *should*
 * happen given a count, and says plainly when the answer is "nothing".
 */

export type StockPlanRefusal = "no-change" | "insufficient" | "negative";

export type StockPlan =
  | {
      ok: true;
      direction: MovementDirection;
      /** Always positive. `direction` carries the sign. */
      quantity: number;
      /** What the lot will read once this is applied. */
      balanceAfter: number;
    }
  | { ok: false; reason: StockPlanRefusal; message: string };

/**
 * Correct a count to what was physically counted.
 *
 * The delta is derived rather than typed, because the person holding the shelf
 * knows what they counted, not what the difference is - and making them
 * subtract is how a correction becomes a second error.
 *
 * A count equal to the system's is refused rather than written as a zero-unit
 * movement: a ledger full of "corrected by 0" entries is a ledger nobody
 * reads, and the honest answer is that there was nothing to correct.
 */
export function planAdjustment(onHand: number, counted: number): StockPlan {
  if (!Number.isInteger(counted) || counted < 0) {
    return {
      ok: false,
      reason: "negative",
      message: "Count in whole units, and not below zero.",
    };
  }

  const delta = counted - onHand;

  if (delta === 0) {
    return {
      ok: false,
      reason: "no-change",
      message: `The count already reads ${onHand}. Nothing to correct.`,
    };
  }

  return {
    ok: true,
    direction: delta > 0 ? "in" : "out",
    quantity: Math.abs(delta),
    balanceAfter: counted,
  };
}

/**
 * Take a number of units off a lot - written off, or sent to another branch.
 *
 * Shared by both because they are the same arithmetic with different
 * paperwork, and a lot that could be over-drawn by one route but not the other
 * would be a lot that goes negative by whichever route was forgotten.
 */
export function planRemoval(onHand: number, quantity: number): StockPlan {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      reason: "negative",
      message: "Enter a whole number of units, at least one.",
    };
  }

  if (quantity > onHand) {
    return {
      ok: false,
      reason: "insufficient",
      message:
        onHand === 0
          ? "That lot has nothing left on the shelf."
          : `Only ${onHand} unit${onHand === 1 ? "" : "s"} are on the shelf.`,
    };
  }

  return {
    ok: true,
    direction: "out",
    quantity,
    balanceAfter: onHand - quantity,
  };
}
