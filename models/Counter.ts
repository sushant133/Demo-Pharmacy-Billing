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

/** Next value in a named sequence. */
export async function nextSequence(
  key: string,
  session: ClientSession | null = null,
): Promise<number> {
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...sessionOption(session) },
  ).lean();

  if (!doc) throw new Error(`Could not allocate a number from sequence "${key}".`);
  return doc.seq;
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
 * Formatted goods-received note number, e.g. GRN-000042.
 * Shares the same atomic sequence machinery as bill numbers.
 */
export function formatGrnNo(seq: number): string {
  return `GRN-${String(seq).padStart(6, "0")}`;
}
