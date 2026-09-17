import {
  Schema,
  model,
  models,
  type ClientSession,
  type InferSchemaType,
  type Model,
} from "mongoose";
import { sessionOption } from "@/lib/transaction";

/**
 * Atomic sequence generator for human-facing numbers (bill numbers today,
 * purchase-order and GRN numbers in Phase 2).
 *
 * `findOneAndUpdate` with `$inc` is atomic at the document level, so two
 * concurrent sales can never receive the same bill number - unlike a
 * `count() + 1` scheme, which races badly at a busy counter.
 */
const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

export type CounterDoc = InferSchemaType<typeof counterSchema>;

export const Counter: Model<CounterDoc> =
  (models.Counter as Model<CounterDoc>) ??
  model<CounterDoc>("Counter", counterSchema);

/**
 * Next value in a named sequence.
 *
 * `seed` is consulted only when the counter did not exist yet, and answers
 * "what is the highest number already issued under this sequence?".
 *
 * That case is not hypothetical. A counter can be absent while records that
 * used it are still on file: a pharmacy whose counters predate the move to
 * per-pharmacy keys, a database restored from a backup, an imported dataset.
 * Starting such a sequence at 1 hands out a number that already exists, and
 * the unique index on {pharmacyId, billNo} then rejects the write - which
 * surfaces at the counter as a bare "already in use" conflict on a sale that
 * has nothing wrong with it. Seeding from the records themselves means the
 * sequence cannot disagree with the documents it numbers.
 */
export async function nextSequence(
  key: string,
  session: ClientSession | null = null,
  seed?: () => Promise<number>,
): Promise<number> {
  return allocateSequence({
    // `new: false` returns the document as it stood *before* the increment,
    // and null when the upsert created it. That null is the signal that this
    // sequence has never issued a number in this database.
    bump: async () => {
      const before = await Counter.findByIdAndUpdate(
        key,
        { $inc: { seq: 1 } },
        { new: false, upsert: true, ...sessionOption(session) },
      ).lean();
      return before ? before.seq : null;
    },
    set: async (value) => {
      await Counter.findByIdAndUpdate(
        key,
        { $set: { seq: value } },
        sessionOption(session),
      );
    },
    seed,
  });
}

/**
 * The allocation rule on its own, with the database swapped for two callbacks.
 *
 * Bill numbering is as business-critical as FEFO and fails the same way - by
 * being quietly wrong rather than loudly broken - so like `lib/fefo.ts` it is
 * kept pure and pinned by tests.
 */
export async function allocateSequence({
  bump,
  set,
  seed,
}: {
  /** Increment, returning the value before it, or null if it was just created. */
  bump: () => Promise<number | null>;
  /** Force the counter to a value. */
  set: (value: number) => Promise<void>;
  /** Highest number already issued under this sequence. */
  seed?: () => Promise<number>;
}): Promise<number> {
  const before = await bump();
  if (before !== null) return before + 1;

  // Freshly created, so it currently reads 1. With no records behind it, 1 is
  // correct and costs nothing to confirm.
  if (!seed) return 1;

  const issued = await seed();
  if (issued < 1) return 1;

  // Records already exist. Lift the counter past them in one write, so the
  // next caller continues from here rather than replaying this.
  const next = issued + 1;
  await set(next);
  return next;
}

/**
 * Formatted bill number, e.g. INV-2082-83-000173.
 *
 * IRD numbering is per Nepali fiscal year (Shrawan–Ashadh) and must not use
 * a slash — `/bills/INV-2082/83-…` would break routing. The printed bill
 * shows 2082/83.
 */
export function formatBillNo(
  seq: number,
  fiscalYear?: string,
  prefix = "INV",
): string {
  const n = String(seq).padStart(6, "0");
  return fiscalYear ? `${prefix}-${fiscalYear}-${n}` : `${prefix}-${n}`;
}

/** Printed form of a stored bill number: INV-2082-83-000001 → INV-2082/83-000001 */
export function displayBillNo(billNo: string): string {
  return billNo.replace(/^(INV-\d{4})-(\d{2}-)/, "$1/$2");
}

/**
 * What to look up in the database when someone types a bill number.
 * Printed receipts use a slash in the fiscal year; stored numbers use a hyphen.
 */
export function storedBillNo(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/^(INV-\d{4})\/(\d{2}-)/, "$1-$2");
}

/**
 * Formatted goods-received note number, e.g. GRN-000042.
 * Shares the same atomic sequence machinery as bill numbers.
 */
export function formatGrnNo(seq: number): string {
  return `GRN-${String(seq).padStart(6, "0")}`;
}
