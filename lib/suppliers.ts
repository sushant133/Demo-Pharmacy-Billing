import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { round2 } from "@/lib/purchase-math";
import { refreshPaymentStatus } from "@/lib/purchases";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import type { SupplierPaymentInput } from "@/lib/validation";
import type { SessionUser } from "@/lib/session";

/**
 * Supplier ledger.
 *
 * Balances are always derived, never stored:
 *
 *   owed = opening balance + posted purchases - payments made
 *
 * A stored running total drifts the first time a write half-succeeds, and a
 * payables figure nobody trusts is worse than none. Draft and cancelled
 * purchases are excluded - a draft is not yet a liability, and a cancelled GRN
 * never was.
 */

export interface SupplierBalance {
  supplierId: string;
  openingBalance: number;
  /** Total of posted purchases. */
  purchased: number;
  paid: number;
  /** What the shop still owes. Negative means the supplier is in credit. */
  outstanding: number;
  postedPurchaseCount: number;
  /** Posted purchases still not fully settled. */
  unpaidInvoiceCount: number;
  /** Outstanding value of invoices already past their due date. */
  overdueAmount: number;
}

export async function getSupplierBalance(
  supplierId: string,
  pharmacyId: Types.ObjectId,
): Promise<SupplierBalance> {
  await connectDB();

  const objectId = new Types.ObjectId(supplierId);
  const now = new Date();
  const tenant = { pharmacyId, supplierId: objectId };

  const [supplier, purchaseAgg, paymentAgg, overdueAgg] = await Promise.all([
    Supplier.findOne({ _id: objectId, pharmacyId }).select("openingBalance").lean(),
    Purchase.aggregate([
      { $match: { ...tenant, status: "posted" } },
      {
        $group: {
          _id: null,
          purchased: { $sum: "$totalAmount" },
          count: { $sum: 1 },
          unpaid: {
            $sum: { $cond: [{ $ne: ["$paymentStatus", "paid"] }, 1, 0] },
          },
        },
      },
    ]),
    SupplierPayment.aggregate([
      { $match: tenant },
      { $group: { _id: null, paid: { $sum: "$amount" } } },
    ]),
    Purchase.aggregate([
      {
        $match: {
          ...tenant,
          status: "posted",
          paymentStatus: { $ne: "paid" },
          dueDate: { $lt: now },
        },
      },
      {
        $group: {
          _id: null,
          overdue: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
        },
      },
    ]),
  ]);

  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");

  const stats = (purchaseAgg[0] ?? {}) as {
    purchased?: number;
    count?: number;
    unpaid?: number;
  };
  const openingBalance = round2(supplier.openingBalance ?? 0);
  const purchased = round2(stats.purchased ?? 0);
  const paid = round2((paymentAgg[0] as { paid?: number } | undefined)?.paid ?? 0);

  return {
    supplierId,
    openingBalance,
    purchased,
    paid,
    outstanding: round2(openingBalance + purchased - paid),
    postedPurchaseCount: stats.count ?? 0,
    unpaidInvoiceCount: stats.unpaid ?? 0,
    overdueAmount: round2(
      (overdueAgg[0] as { overdue?: number } | undefined)?.overdue ?? 0,
    ),
  };
}

/** Balances for many suppliers at once, for the supplier list screen. */
export async function getBalancesFor(
  supplierIds: readonly Types.ObjectId[],
  pharmacyId?: Types.ObjectId | null,
): Promise<Map<string, { purchased: number; paid: number }>> {
  if (supplierIds.length === 0) return new Map();
  await connectDB();

  const tenant = pharmacyId
    ? { pharmacyId }
    : { pharmacyId: { $in: [] as const } };

  const [purchases, payments] = await Promise.all([
    Purchase.aggregate([
      { $match: { ...tenant, supplierId: { $in: supplierIds }, status: "posted" } },
      { $group: { _id: "$supplierId", purchased: { $sum: "$totalAmount" } } },
    ]),
    SupplierPayment.aggregate([
      { $match: { ...tenant, supplierId: { $in: supplierIds } } },
      { $group: { _id: "$supplierId", paid: { $sum: "$amount" } } },
    ]),
  ]);

  const result = new Map<string, { purchased: number; paid: number }>();
  for (const id of supplierIds) {
    result.set(String(id), { purchased: 0, paid: 0 });
  }
  for (const row of purchases as Array<{ _id: Types.ObjectId; purchased: number }>) {
    const entry = result.get(String(row._id));
    if (entry) entry.purchased = round2(row.purchased);
  }
  for (const row of payments as Array<{ _id: Types.ObjectId; paid: number }>) {
    const entry = result.get(String(row._id));
    if (entry) entry.paid = round2(row.paid);
  }
  return result;
}

/**
 * Record a payment to a supplier.
 *
 * When the payment names an invoice, that invoice's paid amount and status are
 * recomputed from its payment records afterwards - derived, not incremented,
 * so a retry cannot double-count.
 */
export async function recordPayment(
  input: SupplierPaymentInput,
  user: SessionUser,
): Promise<{ id: string; amount: number }> {
  await connectDB();

  const pharmacyId = pharmacyObjectId(user);
  const supplier = await Supplier.findOne({ _id: input.supplierId, pharmacyId })
    .select("_id name")
    .lean();
  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");

  let grnNo = "";

  if (input.purchaseId) {
    const purchase = await Purchase.findOne({ _id: input.purchaseId, pharmacyId })
      .select("_id grnNo supplierId status totalAmount amountPaid")
      .lean();

    if (!purchase) throw ApiError.notFound("That purchase no longer exists.");
    if (String(purchase.supplierId) !== String(supplier._id)) {
      throw ApiError.badRequest(
        "That invoice belongs to a different supplier.",
      );
    }
    if (purchase.status !== "posted") {
      throw ApiError.badRequest(
        `${purchase.grnNo} is ${purchase.status}. Only posted purchases can be paid.`,
      );
    }

    const outstanding = round2(purchase.totalAmount - purchase.amountPaid);
    if (input.amount > outstanding + 0.005) {
      throw ApiError.badRequest(
        `${purchase.grnNo} only has ${outstanding.toFixed(2)} outstanding. Record the excess as an on-account payment instead.`,
      );
    }
    grnNo = purchase.grnNo;
  }

  const payment = await SupplierPayment.create({
    pharmacyId,
    supplierId: supplier._id,
    purchaseId: input.purchaseId ? new Types.ObjectId(input.purchaseId) : null,
    grnNo,
    amount: input.amount,
    method: input.method,
    paidOn: input.paidOn,
    reference: input.reference,
    note: input.note,
    recordedBy: new Types.ObjectId(user.id),
    recordedByName: user.name,
  });

  if (input.purchaseId) await refreshPaymentStatus(input.purchaseId);

  return { id: String(payment._id), amount: payment.amount };
}

/** Remove a payment and re-derive the affected invoice's status. */
export async function deletePayment(
  paymentId: string,
  user: SessionUser,
): Promise<void> {
  await connectDB();

  const payment = await SupplierPayment.findOne({
    _id: paymentId,
    ...pharmacyFilter(user),
  })
    .select("_id purchaseId")
    .lean();
  if (!payment) throw ApiError.notFound("That payment no longer exists.");

  await SupplierPayment.deleteOne({ _id: paymentId, ...pharmacyFilter(user) });
  if (payment.purchaseId) await refreshPaymentStatus(payment.purchaseId);
}

/** Total the shop owes across every supplier - shown on the dashboard. */
export async function getTotalPayables(user: SessionUser): Promise<{
  outstanding: number;
  overdue: number;
  supplierCount: number;
}> {
  await connectDB();
  const scoped = pharmacyFilter(user);

  const [openingAgg, purchaseAgg, paymentAgg, overdueAgg, supplierCount] =
    await Promise.all([
      Supplier.aggregate([
        { $match: { ...scoped, isActive: { $ne: false } } },
        { $group: { _id: null, opening: { $sum: "$openingBalance" } } },
      ]),
      Purchase.aggregate([
        { $match: { ...scoped, status: "posted" } },
        { $group: { _id: null, purchased: { $sum: "$totalAmount" } } },
      ]),
      SupplierPayment.aggregate([
        { $match: scoped },
        { $group: { _id: null, paid: { $sum: "$amount" } } },
      ]),
      Purchase.aggregate([
        {
          $match: {
            ...scoped,
            status: "posted",
            paymentStatus: { $ne: "paid" },
            dueDate: { $lt: new Date() },
          },
        },
        {
          $group: {
            _id: null,
            overdue: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
          },
        },
      ]),
      Supplier.countDocuments({ ...scoped, isActive: { $ne: false } }),
    ]);

  const opening = (openingAgg[0] as { opening?: number } | undefined)?.opening ?? 0;
  const purchased =
    (purchaseAgg[0] as { purchased?: number } | undefined)?.purchased ?? 0;
  const paid = (paymentAgg[0] as { paid?: number } | undefined)?.paid ?? 0;

  return {
    outstanding: round2(opening + purchased - paid),
    overdue: round2((overdueAgg[0] as { overdue?: number } | undefined)?.overdue ?? 0),
    supplierCount,
  };
}
