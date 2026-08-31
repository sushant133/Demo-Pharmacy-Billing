import mongoose, { type ClientSession } from "mongoose";
import { connectDB, supportsTransactions } from "@/lib/db";

/**
 * Transaction helper with a safe standalone fallback.
 *
 * MongoDB only offers multi-document transactions on a replica set or sharded
 * cluster. A plain `apt install mongodb-org` on a VPS is standalone, and a
 * sale that half-succeeded there would leave stock and sales records out of
 * sync - the exact failure this system cannot afford.
 *
 * So:
 *   - Replica set / sharded  -> a real transaction, retried on transient
 *     errors (write conflicts under concurrent sales).
 *   - Standalone             -> `session` is null. Callers must then use
 *     conditional atomic updates (`$inc` guarded by `quantity: { $gte: n }`)
 *     and register compensating actions with `onRollback`, which run if a
 *     later step fails. Not true ACID, but no silent desync.
 */

export interface TxContext {
  /** Non-null only when the deployment supports transactions. */
  session: ClientSession | null;
  /**
   * Register an undo action, executed in reverse order if the unit of work
   * throws while running without a real transaction. Ignored when a real
   * transaction is active, since the abort handles rollback.
   */
  onRollback: (undo: () => Promise<unknown>) => void;
  /** True when running under a real MongoDB transaction. */
  transactional: boolean;
}

/** Transient errors worth retrying: write conflicts and commit races. */
function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const labels = (err as { errorLabels?: string[] }).errorLabels ?? [];
  return (
    labels.includes("TransientTransactionError") ||
    labels.includes("UnknownTransactionCommitResult")
  );
}

const MAX_ATTEMPTS = 3;

export async function withTransaction<T>(
  work: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  await connectDB();

  if (await supportsTransactions()) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const session = await mongoose.startSession();
      try {
        let result!: T;
        await session.withTransaction(async () => {
          result = await work({
            session,
            onRollback: () => {
              /* abort() handles rollback */
            },
            transactional: true,
          });
        });
        return result;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
        // Brief backoff before retrying a write conflict.
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      } finally {
        await session.endSession();
      }
    }

    throw lastError;
  }

  // ---- Standalone fallback: manual compensation ----------------------------
  const undos: Array<() => Promise<unknown>> = [];

  try {
    return await work({
      session: null,
      onRollback: (undo) => undos.push(undo),
      transactional: false,
    });
  } catch (err) {
    // Undo in reverse order. A failing undo is logged but never masks the
    // original error, which is what the caller actually needs to see.
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch (undoErr) {
        console.error(
          "[transaction] compensating rollback failed - manual review needed",
          undoErr,
        );
      }
    }
    throw err;
  }
}

/** Spread into Mongoose query options; a no-op without a real session. */
export function sessionOption(session: ClientSession | null) {
  return session ? { session } : {};
}
