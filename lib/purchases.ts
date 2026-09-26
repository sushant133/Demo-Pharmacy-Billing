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
import {
  PurchaseReturnError,
  planPurchaseReturn,
  purchaseReturnTerms,
} from "@/lib/purchase-return";
import type { PurchaseInput, PurchaseReturnInput } from "@/lib/validation";
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

    // GRN numbers run continuously, not per fiscal year.
    const seq = await nextSequence(
      `${String(pharmacyId)}:grn`,
      session,
      async () => {
        const last = await Purchase.findOne({ pharmacyId })
          .sort({ grnSeq: -1 })
          .select("grnSeq")
          .session(session)
          .lean();
        return last?.grnSeq ?? 0;
      },
    );
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
          dueDate: addDays(
            input.receivedDate,
            // A per-delivery term beats the supplier default; 0 is a real
            // answer ("due on receipt"), so only null falls back.
            input.creditDays ?? supplier.paymentTermsDays ?? 0,
          ),
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
  const posted = await postPurchase(created.id, user, input.payment);

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
    dueDate: addDays(
      input.receivedDate,
      input.creditDays ?? supplier.paymentTermsDays ?? 0,
    ),
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
/** Money handed over as the delivery was received. */
export interface PostPayment {
  amount: number;
  method: string;
  reference?: string;
}

export async function postPurchase(
  id: string,
  user: SessionUser,
  payment?: PostPayment,
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

    /*
      Money handed over at the door, recorded in the same transaction as the
      stock it paid for.

      Written straight to the ledger rather than through `recordPayment`,
      because that helper opens its own transaction - nesting one inside this
      would leave a payment that could commit while the stock it settles rolled
      back. Same reason the paid total is set here rather than by calling
      `refreshPaymentStatus` afterwards: a second pass is a second chance to be
      interrupted, and this has to be all-or-nothing.

      Overpayment is refused rather than accepted as a credit. A supplier
      credit balance is a thing this system does not track, and quietly
      creating one would put money somewhere nothing can later spend it.
    */
    if (payment && payment.amount > 0) {
      const paid = round2(payment.amount);

      if (paid > purchase.totalAmount) {
        throw ApiError.badRequest(
          `${purchase.grnNo} totals ${purchase.totalAmount.toFixed(2)}, so ${paid.toFixed(2)} is more than is owed on it. Record the difference as a separate on-account payment.`,
        );
      }

      const { SupplierPayment } = await import("@/models/SupplierPayment");

      const [recorded] = await SupplierPayment.create(
        [
          {
            pharmacyId,
            supplierId: purchase.supplierId,
            purchaseId: purchase._id,
            grnNo: purchase.grnNo,
            amount: paid,
            method: payment.method,
            paidOn: purchase.receivedDate,
            reference: payment.reference ?? "",
            note: "Paid when the delivery was received.",
            recordedBy: new Types.ObjectId(user.id),
            recordedByName: user.name,
          },
        ],
        sessionOption(session),
      );

      if (!recorded) throw new Error("Payment record was not created.");
      onRollback(() => SupplierPayment.deleteOne({ _id: recorded._id }).exec());

      purchase.amountPaid = paid;
      purchase.paymentStatus = paymentStatusFor(purchase.totalAmount, paid);
    }

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
 * Cancelling is for a GRN that should never have been posted - the wrong
 * supplier, a duplicate entry, a delivery keyed twice. Sending goods *back* is
 * a different act on a delivery that was correctly recorded, and it has its
 * own flow in `returnPurchaseItems`: the GRN stays posted, the units leave,
 * and a debit note reduces what the shop owes. Reach for that one whenever the
 * delivery genuinely happened.
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
    .select("totalAmount returnedTotal pharmacyId")
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

  // Netted against what is actually owed, not the invoice face value. A
  // delivery half of which went back is settled by paying half - and if this
  // compared against the gross figure, recording that payment would flip a
  // GRN the credit note had already closed straight back to "partial".
  const netPayable = round2(
    Math.max(0, purchase.totalAmount - (purchase.returnedTotal ?? 0)),
  );

  await Purchase.updateOne(
    { _id: purchaseObjectId, ...(purchase.pharmacyId ? { pharmacyId: purchase.pharmacyId } : {}) },
    {
      $set: {
        amountPaid: paid,
        paymentStatus: paymentStatusFor(netPayable, paid),
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

  const prices = new Map(
    rows.map((row) => [
      String(row._id),
      {
        costPrice: row.costPrice,
        salePrice: row.salePrice,
        supplierId: row.supplierId ? String(row.supplierId) : null,
      },
    ]),
  );

  /*
    A medicine that has never been delivered has no lot to copy from, so the
    GRN form opened blank and somebody typed the MRP off the box - every time,
    for every new line. The catalogue's indicative prices fill exactly that
    gap.

    Only where there is no real lot. A delivered medicine's last actual cost
    beats a figure somebody typed into the catalogue months ago, and a default
    that quietly overrode history would be the second source of truth this
    system is built to avoid.
  */
  const missing = await Medicine.find({
    pharmacyId,
    _id: { $nin: [...prices.keys()].map((id) => new Types.ObjectId(id)) },
    $or: [
      { defaultCostPrice: { $ne: null } },
      { defaultSalePrice: { $ne: null } },
    ],
  })
    .select("_id defaultCostPrice defaultSalePrice")
    .lean();

  for (const medicine of missing) {
    prices.set(String(medicine._id), {
      costPrice: medicine.defaultCostPrice ?? 0,
      salePrice: medicine.defaultSalePrice ?? 0,
      supplierId: null,
    });
  }

  return prices;
}

export { round4 };

// ---------------------------------------------------------------------------
// Returning goods to the supplier
// ---------------------------------------------------------------------------

export interface RecordedPurchaseReturn {
  id: string;
  grnNo: string;
  supplierName: string;
  units: number;
  totalAmount: number;
  returnedTotal: number;
  /** What is still owed on this GRN after the credit. */
  netPayable: number;
  lines: Array<{ medicineName: string; batchNumber: string; quantity: number }>;
}

/**
 * Send units from a posted GRN back to the supplier.
 *
 * The mirror of `returnSaleItems`, and built the same way on purpose: the GRN
 * is never rewritten, stock leaves through a guarded decrement, and the credit
 * is appended so the history of a disputed delivery survives.
 *
 * What the shop is owed is subtracted from what it owes - a debit note, not a
 * refund to chase. `lib/suppliers.ts` nets `returnedTotal` off the posted
 * purchase value, so the payables figure moves the moment this commits and no
 * second step can be forgotten.
 *
 * The stock decrement is the interesting guard. Unlike a customer return,
 * which puts units *back*, this takes them away, so it can lose a race with a
 * sale: a cashier may dispense the last two of a lot while the storekeeper is
 * typing the return. `$gte` refuses rather than driving the lot negative, and
 * the message says what actually happened.
 */
export async function returnPurchaseItems(
  id: string,
  input: PurchaseReturnInput,
  user: SessionUser,
): Promise<RecordedPurchaseReturn> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const pharmacyId = pharmacyObjectId(user);

    const purchase = await Purchase.findOne({ _id: id, pharmacyId }).session(
      session,
    );
    if (!purchase) throw ApiError.notFound("That delivery no longer exists.");

    // What is physically left in each lot decides what may go back, so the
    // lots are read now rather than trusted from the GRN's own quantities.
    const batchIds = purchase.items
      .map((item) => item.batchId)
      .filter((batchId): batchId is Types.ObjectId => Boolean(batchId));

    const lots = await Batch.find({ _id: { $in: batchIds }, pharmacyId })
      .select("_id quantity")
      .session(session)
      .lean();

    const onHand = new Map(lots.map((lot) => [String(lot._id), lot.quantity]));

    let plan;
    try {
      plan = planPurchaseReturn(
        {
          status: purchase.status,
          items: purchase.items.map((item) => ({
            receivedQuantity: item.quantity + item.freeQuantity,
            returnedQuantity: item.returnedQuantity ?? 0,
            onHandQuantity: item.batchId
              ? (onHand.get(String(item.batchId)) ?? 0)
              : 0,
            effectiveUnitCost: item.effectiveUnitCost,
            medicineId: String(item.medicineId),
            medicineName: item.medicineName,
            batchId: item.batchId ? String(item.batchId) : null,
            batchNumber: item.batchNumber,
          })),
        },
        input.items,
        purchaseReturnTerms(purchase),
      );
    } catch (error) {
      if (error instanceof PurchaseReturnError) {
        throw ApiError.badRequest(error.message);
      }
      throw error;
    }

    const returnedAt = new Date();

    for (const item of plan.items) {
      const updated = await Batch.findOneAndUpdate(
        { _id: item.batchId, pharmacyId, quantity: { $gte: item.quantity } },
        { $inc: { quantity: -item.quantity } },
        { new: true, ...sessionOption(session) },
      );

      if (!updated) {
        throw ApiError.insufficientStock(
          `${item.medicineName}: lot ${item.batchNumber} no longer holds ${item.quantity} unit(s) - it was dispensed while this return was open.`,
        );
      }

      onRollback(() =>
        Batch.updateOne(
          { _id: item.batchId, pharmacyId },
          { $inc: { quantity: item.quantity } },
        ).exec(),
      );

      const line = purchase.items[item.lineIndex];
      if (line) {
        line.returnedQuantity = (line.returnedQuantity ?? 0) + item.quantity;
      }
    }

    if (!purchase.returns) purchase.set("returns", []);
    purchase.returns.push({
      returnedAt,
      returnedBy: new Types.ObjectId(user.id),
      returnedByName: user.name,
      reasonCode: input.reasonCode,
      reason: input.reason ?? "",
      creditNoteNo: input.creditNoteNo ?? "",
      items: plan.items.map((item) => ({
        lineIndex: item.lineIndex,
        medicineId: new Types.ObjectId(item.medicineId),
        batchId: new Types.ObjectId(item.batchId),
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        quantity: item.quantity,
        unitCost: item.unitCost,
        lineTotal: item.lineTotal,
      })),
      units: plan.units,
      taxableAmount: plan.taxableAmount,
      vatAmount: plan.vatAmount,
      totalAmount: plan.totalAmount,
    });

    purchase.returnedUnits = (purchase.returnedUnits ?? 0) + plan.units;
    purchase.returnedTotal = round2(
      (purchase.returnedTotal ?? 0) + plan.totalAmount,
    );

    await purchase.save({ session: session ?? undefined });

    // A credit can settle an invoice outright, so the payment status is
    // recomputed against the reduced figure rather than left saying "unpaid"
    // on a GRN nobody owes anything on.
    const netPayable = round2(
      Math.max(0, purchase.totalAmount - purchase.returnedTotal),
    );
    await Purchase.updateOne(
      { _id: purchase._id, pharmacyId },
      {
        $set: {
          paymentStatus: paymentStatusFor(netPayable, purchase.amountPaid ?? 0),
        },
      },
      sessionOption(session),
    );

    return {
      id: String(purchase._id),
      grnNo: purchase.grnNo,
      supplierName: purchase.supplierName,
      units: plan.units,
      totalAmount: plan.totalAmount,
      returnedTotal: purchase.returnedTotal,
      netPayable,
      lines: plan.items.map((item) => ({
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        quantity: item.quantity,
      })),
    };
  });
}
