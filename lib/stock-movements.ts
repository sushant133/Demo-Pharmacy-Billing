import { Types, type ClientSession } from "mongoose";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import {
  MOVEMENT_REASON_LABELS,
  type MovementDirection,
  type MovementKind,
  type MovementReason,
} from "@/lib/movement-kinds";
import { planAdjustment, planRemoval } from "@/lib/movement-plan";
import { round2 } from "@/lib/sale-payment";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { pharmacyFilter } from "@/lib/tenant";
import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Medicine } from "@/models/Medicine";
import { StockMovement } from "@/models/StockMovement";
import type { SessionUser } from "@/lib/session";
import type {
  AdjustStockInput,
  TransferStockInput,
  WriteOffStockInput,
} from "@/lib/validation";

/**
 * The three stock movements that had no home.
 *
 * Receiving and dispensing already move stock through their own services -
 * `postPurchase` creates the lot, `createSale` draws it down FEFO - and both
 * leave a document behind that says what happened. Correcting a count, writing
 * off a broken box and moving units between branches did not exist at all:
 * there was no route, no screen and no audit trail, and the only way to fix a
 * miscount was to edit the database by hand.
 *
 * Every write here follows the shape the rest of the system already uses:
 *
 *   - guarded atomic updates, so two clerks cannot both spend the same units
 *   - `withTransaction`, with compensating undo for standalone MongoDB
 *   - an append-only ledger entry, never an edited balance
 *
 * A movement is never deleted. A wrong adjustment is corrected by another one,
 * so the ledger reads as the history it is rather than as the answer somebody
 * last wanted it to give.
 */

export interface MovementResult {
  movementId: string;
  medicineName: string;
  batchNumber: string;
  quantity: number;
  direction: MovementDirection;
  balanceAfter: number;
  value: number;
}

/** A lot, with everything a movement needs to describe itself. */
interface LotContext {
  batchId: Types.ObjectId;
  branchId: Types.ObjectId;
  branchName: string;
  medicineId: Types.ObjectId;
  medicineName: string;
  batchNumber: string;
  expiryDate: Date;
  unit: string;
  quantity: number;
  costPrice: number;
  salePrice: number;
}

async function loadLot(
  user: SessionUser,
  batchId: string,
  session: ClientSession | null,
): Promise<LotContext> {
  const batch = await Batch.findOne({ _id: batchId, ...pharmacyFilter(user) })
    .session(session)
    .lean();
  if (!batch) throw ApiError.notFound("That lot no longer exists.");

  const [medicine, branch] = await Promise.all([
    Medicine.findById(batch.medicineId).select("name unit").session(session).lean(),
    Branch.findById(batch.branchId).select("name").session(session).lean(),
  ]);

  return {
    batchId: batch._id,
    branchId: batch.branchId,
    branchName: branch?.name ?? "",
    medicineId: batch.medicineId,
    medicineName: medicine?.name ?? "Medicine",
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate,
    unit: medicine?.unit ?? "unit",
    quantity: batch.quantity,
    costPrice: batch.costPrice,
    salePrice: batch.salePrice,
  };
}

/** Write one ledger entry. Never called outside a unit of work that moved stock. */
async function record(
  user: SessionUser,
  lot: LotContext,
  entry: {
    kind: MovementKind;
    direction: MovementDirection;
    quantity: number;
    balanceAfter: number;
    reasonCode?: MovementReason | "";
    reason?: string;
    note?: string;
    transferRef?: string;
    counterpartBranchId?: Types.ObjectId | null;
    counterpartBranchName?: string;
    branchId?: Types.ObjectId;
    branchName?: string;
  },
  session: ClientSession | null,
): Promise<string> {
  const value = round2(entry.quantity * lot.costPrice);

  const [movement] = await StockMovement.create(
    [
      {
        ...pharmacyFilter(user),
        branchId: entry.branchId ?? lot.branchId,
        branchName: entry.branchName ?? lot.branchName,
        medicineId: lot.medicineId,
        medicineName: lot.medicineName,
        batchId: lot.batchId,
        batchNumber: lot.batchNumber,
        expiryDate: lot.expiryDate,
        unit: lot.unit,
        kind: entry.kind,
        direction: entry.direction,
        quantity: entry.quantity,
        balanceAfter: entry.balanceAfter,
        unitCost: lot.costPrice,
        value,
        reasonCode: entry.reasonCode ?? "",
        reason: entry.reason ?? "",
        note: entry.note ?? "",
        transferRef: entry.transferRef ?? "",
        counterpartBranchId: entry.counterpartBranchId ?? null,
        counterpartBranchName: entry.counterpartBranchName ?? "",
        performedBy: new Types.ObjectId(user.id),
        performedByName: user.name,
      },
    ],
    sessionOption(session),
  );

  if (!movement) throw new Error("The stock movement was not recorded.");
  return String(movement._id);
}

/**
 * Correct a lot's count to what was physically counted.
 *
 * The form asks for the counted figure rather than a delta, because that is
 * what the person holding the shelf actually knows. The delta is derived, and
 * the count the correction was made against is guarded on: if a sale went
 * through while the stock-take sheet was being typed, the write fails rather
 * than silently undoing it.
 */
export async function adjustStock(
  user: SessionUser,
  input: AdjustStockInput,
): Promise<MovementResult> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const lot = await loadLot(user, input.batchId, session);

    const plan = planAdjustment(lot.quantity, input.countedQuantity);
    if (!plan.ok) throw ApiError.badRequest(`${lot.batchNumber}: ${plan.message}`);
    const { direction, quantity } = plan;

    // Guarded on the count this correction was computed against, so two people
    // typing up the same stock-take cannot both apply it.
    const updated = await Batch.findOneAndUpdate(
      { _id: lot.batchId, ...pharmacyFilter(user), quantity: lot.quantity },
      { $set: { quantity: input.countedQuantity } },
      { new: true, ...sessionOption(session) },
    );

    if (!updated) {
      throw ApiError.conflict(
        `${lot.batchNumber} changed while this correction was being entered - it no longer reads ${lot.quantity}. Re-count and try again.`,
      );
    }

    onRollback(() =>
      Batch.updateOne(
        { _id: lot.batchId },
        { $set: { quantity: lot.quantity } },
      ).exec(),
    );

    const movementId = await record(
      user,
      lot,
      {
        kind: "adjustment",
        direction,
        quantity,
        balanceAfter: updated.quantity,
        reasonCode: input.reasonCode,
        reason: input.reason ?? MOVEMENT_REASON_LABELS[input.reasonCode],
        note: input.note,
      },
      session,
    );

    return {
      movementId,
      medicineName: lot.medicineName,
      batchNumber: lot.batchNumber,
      quantity,
      direction,
      balanceAfter: updated.quantity,
      value: round2(quantity * lot.costPrice),
    };
  });
}

/**
 * Take units off the shelf for good - broken, spoiled, expired or recalled.
 *
 * Distinct from an adjustment on purpose. An adjustment says the count was
 * wrong; a write-off says the count was right and the stock is gone. They are
 * different questions to an auditor and different lines in a set of accounts,
 * so conflating them into "quantity went down" would lose the only fact worth
 * keeping.
 */
export async function writeOffStock(
  user: SessionUser,
  input: WriteOffStockInput,
): Promise<MovementResult> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const lot = await loadLot(user, input.batchId, session);

    const plan = planRemoval(lot.quantity, input.quantity);
    if (!plan.ok) throw ApiError.badRequest(`${lot.batchNumber}: ${plan.message}`);

    // `$gte` rather than an equality guard: another write-off or a sale taking
    // units in the meantime is fine as long as enough are still there.
    const updated = await Batch.findOneAndUpdate(
      {
        _id: lot.batchId,
        ...pharmacyFilter(user),
        quantity: { $gte: input.quantity },
      },
      { $inc: { quantity: -input.quantity } },
      { new: true, ...sessionOption(session) },
    );

    if (!updated) {
      throw ApiError.insufficientStock(
        `${lot.batchNumber} no longer holds ${input.quantity} units - something else drew it down while this was open.`,
      );
    }

    onRollback(() =>
      Batch.updateOne(
        { _id: lot.batchId },
        { $inc: { quantity: input.quantity } },
      ).exec(),
    );

    const movementId = await record(
      user,
      lot,
      {
        kind: "damage",
        direction: "out",
        quantity: input.quantity,
        balanceAfter: updated.quantity,
        reasonCode: input.reasonCode,
        reason: input.reason ?? MOVEMENT_REASON_LABELS[input.reasonCode],
        note: input.note,
      },
      session,
    );

    return {
      movementId,
      medicineName: lot.medicineName,
      batchNumber: lot.batchNumber,
      quantity: input.quantity,
      direction: "out",
      balanceAfter: updated.quantity,
      value: round2(input.quantity * lot.costPrice),
    };
  });
}

export interface TransferResult extends MovementResult {
  transferRef: string;
  toBranchName: string;
  /** The lot at the destination, created or topped up. */
  destinationBatchId: string;
}

/**
 * Move units of one lot from the branch that holds it to another.
 *
 * A lot belongs to one branch - that is what makes two outlets' stock separate
 * rather than one pooled pile - so a transfer is not a field change. It is a
 * decrement at the source and a matching lot at the destination, created if
 * that branch has never held this lot number and topped up if it has.
 *
 * The destination lot keeps the source's expiry and cost, because they are
 * facts about the physical boxes rather than about where they sit. Sale price
 * follows too when the destination is new, so the units do not arrive priced
 * at zero; an existing destination lot keeps the price that branch already
 * charges.
 */
export async function transferStock(
  user: SessionUser,
  input: TransferStockInput,
): Promise<TransferResult> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const lot = await loadLot(user, input.batchId, session);

    if (String(lot.branchId) === String(input.toBranchId)) {
      throw ApiError.badRequest(
        "The destination is the branch that already holds this lot.",
      );
    }

    const destination = await Branch.findOne({
      _id: input.toBranchId,
      ...pharmacyFilter(user),
      isActive: true,
    })
      .select("name")
      .session(session)
      .lean();

    if (!destination) {
      throw ApiError.badRequest("That destination branch is not open.");
    }

    const plan = planRemoval(lot.quantity, input.quantity);
    if (!plan.ok) throw ApiError.badRequest(`${lot.batchNumber}: ${plan.message}`);

    // --- Out of the source ------------------------------------------------
    const source = await Batch.findOneAndUpdate(
      {
        _id: lot.batchId,
        ...pharmacyFilter(user),
        quantity: { $gte: input.quantity },
      },
      { $inc: { quantity: -input.quantity } },
      { new: true, ...sessionOption(session) },
    );

    if (!source) {
      throw ApiError.insufficientStock(
        `${lot.batchNumber} no longer holds ${input.quantity} units - something else drew it down while this was open.`,
      );
    }

    onRollback(() =>
      Batch.updateOne(
        { _id: lot.batchId },
        { $inc: { quantity: input.quantity } },
      ).exec(),
    );

    // --- Into the destination ---------------------------------------------
    //
    // Upserted on the branch's uniqueness rule - {branchId, medicineId,
    // batchNumber} - so a second transfer of the same lot tops up what is
    // already there instead of failing on the index.
    const existing = await Batch.findOne({
      ...pharmacyFilter(user),
      branchId: input.toBranchId,
      medicineId: lot.medicineId,
      batchNumber: lot.batchNumber,
    })
      .session(session)
      .lean();

    let destinationBatchId: Types.ObjectId;

    if (existing) {
      const toppedUp = await Batch.findOneAndUpdate(
        { _id: existing._id },
        {
          $inc: { quantity: input.quantity, initialQuantity: input.quantity },
        },
        { new: true, ...sessionOption(session) },
      );
      if (!toppedUp) throw new Error("The destination lot vanished mid-transfer.");
      destinationBatchId = existing._id;

      onRollback(() =>
        Batch.updateOne(
          { _id: existing._id },
          {
            $inc: { quantity: -input.quantity, initialQuantity: -input.quantity },
          },
        ).exec(),
      );
    } else {
      const [created] = await Batch.create(
        [
          {
            ...pharmacyFilter(user),
            branchId: new Types.ObjectId(input.toBranchId),
            medicineId: lot.medicineId,
            batchNumber: lot.batchNumber,
            expiryDate: lot.expiryDate,
            quantity: input.quantity,
            initialQuantity: input.quantity,
            costPrice: lot.costPrice,
            salePrice: lot.salePrice,
            notes: `Transferred from ${lot.branchName || "another branch"}`,
          },
        ],
        sessionOption(session),
      );
      if (!created) throw new Error("The destination lot was not created.");
      destinationBatchId = created._id;

      onRollback(() => Batch.deleteOne({ _id: created._id }).exec());
    }

    // --- The ledger, both sides -------------------------------------------
    //
    // One reference shared by the pair, so the two halves read back as the one
    // event they are, and each names the branch at the far end so either side
    // makes sense on its own screen.
    const transferRef = `TRF-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const movementId = await record(
      user,
      lot,
      {
        kind: "transfer-out",
        direction: "out",
        quantity: input.quantity,
        balanceAfter: source.quantity,
        reason: input.reason ?? "",
        note: input.note,
        transferRef,
        counterpartBranchId: new Types.ObjectId(input.toBranchId),
        counterpartBranchName: destination.name,
      },
      session,
    );

    const landed = await Batch.findById(destinationBatchId)
      .select("quantity")
      .session(session)
      .lean();

    await record(
      user,
      { ...lot, batchId: destinationBatchId },
      {
        kind: "transfer-in",
        direction: "in",
        quantity: input.quantity,
        balanceAfter: landed?.quantity ?? input.quantity,
        reason: input.reason ?? "",
        note: input.note,
        transferRef,
        branchId: new Types.ObjectId(input.toBranchId),
        branchName: destination.name,
        counterpartBranchId: lot.branchId,
        counterpartBranchName: lot.branchName,
      },
      session,
    );

    return {
      movementId,
      transferRef,
      medicineName: lot.medicineName,
      batchNumber: lot.batchNumber,
      quantity: input.quantity,
      direction: "out",
      balanceAfter: source.quantity,
      value: round2(input.quantity * lot.costPrice),
      toBranchName: destination.name,
      destinationBatchId: String(destinationBatchId),
    };
  });
}
