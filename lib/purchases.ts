import { Types, type ClientSession } from "mongoose";
import { ApiError } from "@/lib/api";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { addDays } from "@/lib/dates";
import {
  calculatePurchaseTotals,
  paymentStatusFor,
  weightedAverageCost,
  round2,
  round4,
} from "@/lib/purchase-math";
import { branchForWrite } from "@/lib/branches";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Supplier } from "@/models/Supplier";
import { formatGrnNo, nextSequence } from "@/models/Counter";
import type { PurchaseInput } from "@/lib/validation";
import type { SessionUser } from "@/lib/session";

/**
 * Purchase / GRN service.
 *
 * The one rule this module exists to enforce: **stock enters the shop only by
 * posting a purchase.** There is no direct batch-create route any more, so
 * every unit on a shelf is traceable to a supplier delivery.
 *
 * A purchase moves through three states:
 *
 *   draft     - typed in, editable, no stock exists yet
 *   posted    - batches created; the GRN is now an accounting document
 *   cancelled - a posted GRN reversed, only while none of it has been sold
 *
 * Splitting entry from posting matters in practice: invoices get typed while
 * the delivery is still being unpacked, and a mistyped expiry date caught
 * before posting costs nothing, while one caught after has already polluted
 * FEFO.
 */

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/** Resolve and validate the supplier + medicines a purchase refers to. */
async function resolveReferences(
  input: PurchaseInput,
  session: ClientSession | null,
  pharmacyId: Types.ObjectId,
) {
  const supplier = await Supplier.findOne({ _id: input.supplierId, pharmacyId })
    .select("_id name isActive paymentTermsDays")
    .session(session)
    .lean();

  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");
  if (supplier.isActive === false) {
    throw ApiError.badRequest(
      `${supplier.name} is marked inactive. Reactivate the supplier before recording a purchase from them.`,
    );
  }

  const medicineIds = [...new Set(input.items.map((item) => item.medicineId))];
  const medicines = await Medicine.find({
    pharmacyId,
    _id: { $in: medicineIds.map((id) => new Types.ObjectId(id)) },
  })
    .select("_id name isActive")
    .session(session)
    .lean();

  const byId = new Map(medicines.map((medicine) => [String(medicine._id), medicine]));
  const missing = medicineIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw ApiError.notFound(
      `${missing.length} item(s) on this purchase are not in the medicine catalogue. Add them first.`,
    );
  }

  return { supplier, medicinesById: byId };
}

/** Build the persisted item + totals shape from validated input. */
function buildItemsAndTotals(
  input: PurchaseInput,
  medicinesById: Map<string, { _id: Types.ObjectId; name: string }>,
) {
  const totals = calculatePurchaseTotals({
    lines: input.items.map((item) => ({
      quantity: item.quantity,
      freeQuantity: item.freeQuantity,
      costPrice: item.costPrice,
      discount: item.discount,
    })),
    discount: input.discount,
    vatRate: input.vatRate,
    otherCharges: input.otherCharges,
  });

  const items = input.items.map((item, index) => {
    // calculatePurchaseTotals returns one entry per input line, in order.
    const line = totals.lines[index]!;
    const medicine = medicinesById.get(item.medicineId)!;

    return {
      medicineId: new Types.ObjectId(item.medicineId),
      medicineName: medicine.name,
      batchNumber: item.batchNumber,
      mfgDate: item.mfgDate,
      expiryDate: item.expiryDate,
      quantity: item.quantity,
      freeQuantity: item.freeQuantity,
      costPrice: item.costPrice,
      effectiveUnitCost: line.effectiveUnitCost,
      salePrice: item.salePrice,
      discount: line.discount,
      lineTotal: line.net,
      batchId: null,
      toppedUpExisting: false,
      applySalePriceToStock: Boolean(item.applySalePriceToStock),
    };
  });

  return { items, totals };
}

/**
 * Reject two lines that describe the same lot of the same medicine.
 * They would race each other during posting and produce a confusing batch.
 */
function assertNoDuplicateLots(input: PurchaseInput) {
  const seen = new Set<string>();
  for (const item of input.items) {
    const key = `${item.medicineId}::${item.batchNumber.trim().toLowerCase()}`;
    if (seen.has(key)) {
      throw ApiError.badRequest(
        `Batch ${item.batchNumber} appears on more than one line for the same medicine. Combine them into a single line.`,
      );
    }
    seen.add(key);
  }
}

// ---------------------------------------------------------------------------
// Create / update / delete (drafts)
// ---------------------------------------------------------------------------

export interface CreatedPurchase {
  id: string;
  grnNo: string;
  status: string;
  totalAmount: number;
  /** Present only when the purchase was posted as part of this call. */
  batchesCreated?: number;
  batchesToppedUp?: number;
  unitsReceived?: number;
}

/** Create a purchase. Posts immediately when `postNow` is set. */
export async function createPurchase(
  input: PurchaseInput,
  user: SessionUser,
  postNow: boolean,
): Promise<CreatedPurchase> {
  await connectDB();
  assertNoDuplicateLots(input);

  const created = await withTransaction(async ({ session, onRollback }) => {
    const branch = await branchForWrite(user);
    const pharmacyId = pharmacyObjectId(user);
    const { supplier, medicinesById } = await resolveReferences(
      input,
      session,
      pharmacyId,
    );
    const { items, totals } = buildItemsAndTotals(input, medicinesById);

    const seq = await nextSequence(`${String(pharmacyId)}:grn`, session);
    const grnNo = formatGrnNo(seq);

    const [purchase] = await Purchase.create(
      [
        {
          pharmacyId,
          grnNo,
          grnSeq: seq,
          supplierId: supplier._id,
          supplierName: supplier.name,
          invoiceNo: input.invoiceNo,
          invoiceDate: input.invoiceDate,
          receivedDate: input.receivedDate,
          status: "draft",
          items,
          subtotal: totals.subtotal,
          discount: totals.discount,
          otherCharges: totals.otherCharges,
          taxableAmount: totals.taxableAmount,
          vatRate: totals.vatRate,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
          amountPaid: 0,
          paymentStatus: "unpaid",
          dueDate: addDays(input.receivedDate, supplier.paymentTermsDays ?? 0),
          createdBy: new Types.ObjectId(user.id),
          createdByName: user.name,
          notes: input.notes,
          branchId: branch.id,
          branchName: branch.name,
        },
      ],
      sessionOption(session),
    );

    if (!purchase) throw new Error("Purchase document was not created.");
    onRollback(() => Purchase.deleteOne({ _id: purchase._id }).exec());

    return {
      id: String(purchase._id),
      grnNo,
      status: "draft",
      totalAmount: totals.totalAmount,
    };
  });

  if (!postNow) return created;

  // Posting runs in its own transaction so a failure there leaves a usable
  // draft behind rather than losing the whole typed invoice.
  const posted = await postPurchase(created.id, user);

  // Carry the posting stats through: a caller using the one-step flow needs to
  // know what actually landed on the shelf, exactly as if they had posted
  // separately.
  return {
    ...created,
    status: posted.status,
    totalAmount: posted.totalAmount,
    batchesCreated: posted.batchesCreated,
    batchesToppedUp: posted.batchesToppedUp,
    unitsReceived: posted.unitsReceived,
  };
}

/** Edit a draft. Posted and cancelled purchases are immutable. */
export async function updateDraftPurchase(
  id: string,
  input: PurchaseInput,
  user: SessionUser,
): Promise<CreatedPurchase> {
  await connectDB();
  assertNoDuplicateLots(input);

  const pharmacyId = pharmacyObjectId(user);
  const purchase = await Purchase.findOne({ _id: id, pharmacyId });
  if (!purchase) throw ApiError.notFound("That purchase no longer exists.");
  assertDraft(purchase.status, purchase.grnNo);

  const { supplier, medicinesById } = await resolveReferences(input, null, pharmacyId);
  const { items, totals } = buildItemsAndTotals(input, medicinesById);

  purchase.set({
    supplierId: supplier._id,
    supplierName: supplier.name,
    invoiceNo: input.invoiceNo,
    invoiceDate: input.invoiceDate,
    receivedDate: input.receivedDate,
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    otherCharges: totals.otherCharges,
    taxableAmount: totals.taxableAmount,
    vatRate: totals.vatRate,
    vatAmount: totals.vatAmount,
    totalAmount: totals.totalAmount,
    dueDate: addDays(input.receivedDate, supplier.paymentTermsDays ?? 0),
    notes: input.notes,
  });

  await purchase.save();

  return {
    id: String(purchase._id),
    grnNo: purchase.grnNo,
    status: purchase.status,
    totalAmount: purchase.totalAmount,
  };
}

function assertDraft(status: string, grnNo: string): void {
  if (status === "posted") {
    throw ApiError.conflict(
      `${grnNo} has already been posted and stock has been created from it. Cancel it instead of editing.`,
    );
  }
  if (status === "cancelled") {
    throw ApiError.conflict(`${grnNo} was cancelled and can no longer be changed.`);
  }
}

/** Delete a draft outright. Posted GRNs are cancelled, never deleted. */
export async function deleteDraftPurchase(
  id: string,
  user: SessionUser,
): Promise<{ grnNo: string }> {
  await connectDB();

  const purchase = await Purchase.findOne({ _id: id, ...pharmacyFilter(user) })
    .select("status grnNo")
    .lean();
  if (!purchase) throw ApiError.notFound("That purchase no longer exists.");
  assertDraft(purchase.status, purchase.grnNo);

  await Purchase.deleteOne({ _id: id, ...pharmacyFilter(user) });
  return { grnNo: purchase.grnNo };
}

// ---------------------------------------------------------------------------
// Posting - the only way stock is created
// ---------------------------------------------------------------------------

export interface PostedPurchase {
  id: string;
  grnNo: string;
  status: string;
  totalAmount: number;
  batchesCreated: number;
  batchesToppedUp: number;
  unitsReceived: number;
}

/**
 * Post a draft: create the stock.
 *
 * For each line, either a new Batch is created or - when that lot number
 * already exists for that medicine - the existing one is topped up. Topping up
 * blends the cost with a weighted average rather than overwriting it, because
 * the units already on the shelf were bought at the old price.
 *
 * Everything happens in one transaction, so a GRN can never be half-posted:
 * either all its stock exists and the document says "posted", or neither.
 */
export async function postPurchase(
  id: string,
  user: SessionUser,
): Promise<PostedPurchase> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const pharmacyId = pharmacyObjectId(user);
    const purchase = await Purchase.findOne({ _id: id, pharmacyId }).session(session);
    if (!purchase) throw ApiError.notFound("That purchase no longer exists.");
    assertDraft(purchase.status, purchase.grnNo);

    if (!purchase.branchId) {
      const branch = await branchForWrite(user);
      purchase.branchId = branch.id;
      purchase.branchName = branch.name;
    }

    let created = 0;
    let toppedUp = 0;
    let units = 0;

    for (const item of purchase.items) {
      const receivedQuantity = item.quantity + item.freeQuantity;
      units += receivedQuantity;

      const existing = await Batch.findOne({
        pharmacyId,
        branchId: purchase.branchId,
        medicineId: item.medicineId,
        batchNumber: item.batchNumber,
      }).session(session);

      if (existing) {
        // Same lot arriving again: blend cost, adopt the new selling price.
        const blendedCost = weightedAverageCost(
          { quantity: existing.quantity, costPrice: existing.costPrice },
          { quantity: receivedQuantity, costPrice: item.effectiveUnitCost },
        );

        const previous = {
          quantity: existing.quantity,
          initialQuantity: existing.initialQuantity,
          costPrice: existing.costPrice,
          salePrice: existing.salePrice,
        };

        existing.quantity += receivedQuantity;
        existing.initialQuantity += receivedQuantity;
        existing.costPrice = blendedCost;
        existing.salePrice = item.salePrice;
        // An existing lot keeps its original GRN link; this receipt is
        // traceable through the purchase item's batchId instead.
        await existing.save({ session: session ?? undefined });

        onRollback(() =>
          Batch.updateOne({ _id: existing._id }, { $set: previous }).exec(),
        );

        item.batchId = existing._id;
        item.toppedUpExisting = true;
        toppedUp++;
      } else {
        const [batch] = await Batch.create(
          [
            {
              pharmacyId,
              branchId: purchase.branchId,
              medicineId: item.medicineId,
              batchNumber: item.batchNumber,
              mfgDate: item.mfgDate,
              expiryDate: item.expiryDate,
              quantity: receivedQuantity,
              initialQuantity: receivedQuantity,
              costPrice: item.effectiveUnitCost,
              salePrice: item.salePrice,
              supplierId: purchase.supplierId,
              grnId: purchase._id,
              grnNo: purchase.grnNo,
            },
          ],
          sessionOption(session),
        );

        if (!batch) throw new Error("Batch was not created while posting.");
        onRollback(() => Batch.deleteOne({ _id: batch._id }).exec());

        item.batchId = batch._id;
        item.toppedUpExisting = false;
        created++;
      }

      if (item.applySalePriceToStock) {
        const previousPrices = await Batch.find({
          pharmacyId,
          branchId: purchase.branchId,
          medicineId: item.medicineId,
          quantity: { $gt: 0 },
        })
          .select("_id salePrice")
          .session(session)
          .lean();

        if (previousPrices.length > 0) {
          await Batch.updateMany(
            { _id: { $in: previousPrices.map((row) => row._id) } },
            { $set: { salePrice: item.salePrice } },
            sessionOption(session),
          );
          onRollback(() =>
            Promise.all(
              previousPrices.map((row) =>
                Batch.updateOne(
                  { _id: row._id },
                  { $set: { salePrice: row.salePrice } },
                ).exec(),
              ),
            ),
          );
        }
      }
    }

    purchase.status = "posted";
    purchase.postedAt = new Date();
    purchase.postedBy = new Types.ObjectId(user.id);
    await purchase.save({ session: session ?? undefined });

    return {
      id: String(purchase._id),
      grnNo: purchase.grnNo,
      status: "posted",
      totalAmount: purchase.totalAmount,
      batchesCreated: created,
      batchesToppedUp: toppedUp,
      unitsReceived: units,
    };
  });
}

/**
 * Reverse a posted GRN.
 *
 * Refused once any unit from it has been sold: unwinding stock that a customer
 * has already walked out with would leave a batch short and the sale record
 * pointing at a lot that no longer accounts for it.
 *
 * There is no purchase-return flow yet, so the documented workaround is a
 * manual batch correction plus a direct settlement with the supplier. A proper
 * debit-note flow is the obvious future addition here.
 */
export async function cancelPurchase(
  id: string,
  reason: string,
  user: SessionUser,
): Promise<{ id: string; grnNo: string; status: string }> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const purchase = await Purchase.findOne({
      _id: id,
      ...pharmacyFilter(user),
    }).session(session);
    if (!purchase) throw ApiError.notFound("That purchase no longer exists.");

    if (purchase.status === "draft") {
      throw ApiError.badRequest(
        `${purchase.grnNo} is still a draft - delete it instead of cancelling.`,
      );
    }
    if (purchase.status === "cancelled") {
      throw ApiError.conflict(`${purchase.grnNo} is already cancelled.`);
    }
    if (purchase.amountPaid > 0) {
      throw ApiError.conflict(
        `${purchase.grnNo} has payments recorded against it. Remove the payments before cancelling.`,
      );
    }

    for (const item of purchase.items) {
      if (!item.batchId) continue;
      const receivedQuantity = item.quantity + item.freeQuantity;

      const batch = await Batch.findById(item.batchId).session(session);
      if (!batch) continue; // already gone; nothing to reverse

      const soldFromBatch = await Sale.countDocuments({
        "items.batchId": batch._id,
        voidedAt: null,
      }).session(session);

      if (soldFromBatch > 0) {
        throw ApiError.conflict(
          `${item.medicineName} batch ${item.batchNumber} from this GRN has already been sold on ${soldFromBatch} bill(s), so the GRN cannot be cancelled without breaking those bills. Correct the batch quantity on the stock screen instead, and settle the difference with the supplier directly.`,
        );
      }

      if (item.toppedUpExisting) {
        // Give back only what this GRN added, leaving the earlier stock alone.
        if (batch.quantity < receivedQuantity) {
          throw ApiError.conflict(
            `Batch ${item.batchNumber} no longer holds the ${receivedQuantity} unit(s) this GRN added, so it cannot be reversed cleanly.`,
          );
        }
        const previous = {
          quantity: batch.quantity,
          initialQuantity: batch.initialQuantity,
        };
        batch.quantity -= receivedQuantity;
        batch.initialQuantity = Math.max(0, batch.initialQuantity - receivedQuantity);
        await batch.save({ session: session ?? undefined });
        onRollback(() =>
          Batch.updateOne({ _id: batch._id }, { $set: previous }).exec(),
        );
      } else {
        const snapshot = batch.toObject();
        await Batch.deleteOne({ _id: batch._id }, sessionOption(session));
        onRollback(() => Batch.create([snapshot], {}).then(() => undefined));
      }

      item.batchId = null;
    }

    purchase.status = "cancelled";
    purchase.cancelledAt = new Date();
    purchase.cancelledBy = new Types.ObjectId(user.id);
    purchase.cancelReason = reason;
    await purchase.save({ session: session ?? undefined });

    return { id: String(purchase._id), grnNo: purchase.grnNo, status: "cancelled" };
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Recompute a purchase's paid amount and status from its payment records. */
export async function refreshPaymentStatus(
  purchaseId: Types.ObjectId | string,
  session: ClientSession | null = null,
): Promise<void> {
  const { SupplierPayment } = await import("@/models/SupplierPayment");

  const purchaseObjectId = new Types.ObjectId(String(purchaseId));
  const purchase = await Purchase.findById(purchaseObjectId)
    .select("totalAmount pharmacyId")
    .session(session)
    .lean();
  if (!purchase) return;

  const paymentMatch: Record<string, unknown> = { purchaseId: purchaseObjectId };
  if (purchase.pharmacyId) paymentMatch.pharmacyId = purchase.pharmacyId;

  const agg = await SupplierPayment.aggregate([
    { $match: paymentMatch },
    { $group: { _id: null, paid: { $sum: "$amount" } } },
  ]).session(session);

  const paid = round2((agg[0] as { paid?: number } | undefined)?.paid ?? 0);

  await Purchase.updateOne(
    { _id: purchaseObjectId, ...(purchase.pharmacyId ? { pharmacyId: purchase.pharmacyId } : {}) },
    {
      $set: {
        amountPaid: paid,
        paymentStatus: paymentStatusFor(purchase.totalAmount, paid),
      },
    },
    sessionOption(session),
  );
}

/** Default VAT rate applied to a new purchase form. */
export function defaultPurchaseVatRate(): number {
  return config.vatRate;
}

export interface LatestBatchPrice {
  costPrice: number;
  salePrice: number;
  supplierId: string | null;
}

/** Most recent lot per medicine, so "Add stock" can pre-fill last cost and MRP. */
export async function latestBatchPrices(
  pharmacyId: Types.ObjectId,
): Promise<Map<string, LatestBatchPrice>> {
  await connectDB();

  const rows = await Batch.aggregate<
    LatestBatchPrice & { _id: Types.ObjectId }
  >([
    { $match: { pharmacyId } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$medicineId",
        costPrice: { $first: "$costPrice" },
        salePrice: { $first: "$salePrice" },
        supplierId: { $first: "$supplierId" },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        costPrice: row.costPrice,
        salePrice: row.salePrice,
        supplierId: row.supplierId ? String(row.supplierId) : null,
      },
    ]),
  );
}

export { round4 };
