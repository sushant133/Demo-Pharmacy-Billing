import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { round2 } from "@/lib/sale-payment";
import { Sale } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import type { SessionUser } from "@/lib/session";

/**
 * What customers still owe.
 *
 * Derived from the bills every time rather than kept as a running total on the
 * customer record. A stored balance has to be adjusted by four different
 * writes - the sale, a later receipt, a return, a void - and the first one
 * that is missed leaves a customer being chased for money they do not owe,
 * with nothing in the data to say which figure is right.
 *
 * Computed from `totalAmount - returnedTotal - amountReceived`, ignoring
 * voided bills, which is the same arithmetic `settleSale` does per bill. The
 * index on {pharmacyId, customerId, paymentStatus, createdAt} is what keeps
 * this cheap: only bills that are not settled are ever read.
 */

/** The unpaid part of a bill, as a Mongo expression. */
const OUTSTANDING = {
  $max: [
    0,
    {
      $subtract: [
        {
          $subtract: ["$totalAmount", { $ifNull: ["$returnedTotal", 0] }],
        },
        { $ifNull: ["$amountReceived", 0] },
      ],
    },
  ],
};

export interface CustomerDue {
  customerId: string;
  customerName: string;
  customerPhone: string;
  /** Bills with something still owing. */
  billCount: number;
  outstanding: number;
  oldest: Date | null;
}

/** Everything one customer still owes, across their bills. */
export async function outstandingForCustomer(
  user: SessionUser,
  customerId: string,
): Promise<number> {
  if (!Types.ObjectId.isValid(customerId)) return 0;
  await connectDB();

  const rows = await Sale.aggregate<{ _id: null; outstanding: number }>([
    {
      $match: {
        ...pharmacyFilter(user),
        customerId: new Types.ObjectId(customerId),
        voidedAt: null,
        paymentStatus: { $in: ["partial", "unpaid"] },
      },
    },
    { $group: { _id: null, outstanding: { $sum: OUTSTANDING } } },
  ]);

  return round2(rows[0]?.outstanding ?? 0);
}

/** Outstanding totals for many customers at once, for a list view. */
export async function outstandingByCustomer(
  user: SessionUser,
  customerIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = customerIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return new Map();

  await connectDB();

  const rows = await Sale.aggregate<{ _id: Types.ObjectId; outstanding: number }>([
    {
      $match: {
        ...pharmacyFilter(user),
        customerId: { $in: ids },
        voidedAt: null,
        paymentStatus: { $in: ["partial", "unpaid"] },
      },
    },
    { $group: { _id: "$customerId", outstanding: { $sum: OUTSTANDING } } },
  ]);

  return new Map(
    rows.map((row) => [String(row._id), round2(row.outstanding)] as const),
  );
}

/**
 * The dues book: every customer with money outstanding, biggest first.
 *
 * Walk-in bills - no customer attached - cannot be chased, so they are not
 * listed here. `unassignedDues` reports them as one figure instead, because a
 * credit sale to nobody is a mistake worth seeing rather than hiding.
 */
export async function customerDues(
  user: SessionUser,
  limit = 100,
): Promise<{ rows: CustomerDue[]; total: number; unassignedDues: number }> {
  await connectDB();

  const match = {
    ...pharmacyFilter(user),
    voidedAt: null,
    paymentStatus: { $in: ["partial", "unpaid"] },
  };

  const [rows, unassigned] = await Promise.all([
    Sale.aggregate<CustomerDue & { _id: Types.ObjectId }>([
      { $match: { ...match, customerId: { $ne: null } } },
      {
        $group: {
          _id: "$customerId",
          customerName: { $last: "$customerName" },
          customerPhone: { $last: "$customerPhone" },
          billCount: { $sum: 1 },
          outstanding: { $sum: OUTSTANDING },
          oldest: { $min: "$createdAt" },
        },
      },
      { $match: { outstanding: { $gt: 0 } } },
      { $sort: { outstanding: -1 } },
      { $limit: limit },
    ]),
    Sale.aggregate<{ _id: null; outstanding: number }>([
      { $match: { ...match, customerId: null } },
      { $group: { _id: null, outstanding: { $sum: OUTSTANDING } } },
    ]),
  ]);

  return {
    rows: rows.map((row) => ({
      customerId: String(row._id),
      customerName: row.customerName || "Customer",
      customerPhone: row.customerPhone || "",
      billCount: row.billCount,
      outstanding: round2(row.outstanding),
      oldest: row.oldest ?? null,
    })),
    total: round2(rows.reduce((sum, row) => sum + row.outstanding, 0)),
    unassignedDues: round2(unassigned[0]?.outstanding ?? 0),
  };
}
