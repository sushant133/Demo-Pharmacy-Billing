import { Types } from "mongoose";
import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchFilter, resolveRequestScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { dateRangeFromStrings } from "@/lib/dates";
import { createPurchase } from "@/lib/purchases";
import { Purchase } from "@/models/Purchase";
import { pharmacyFilter } from "@/lib/tenant";
import { purchaseQuerySchema, purchaseSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/purchases
 * Query: supplierId, status, paymentStatus, from, to, q, page, pageSize
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("purchase:read");
  const { supplierId, status, paymentStatus, from, to, q, page, pageSize } =
    parseQuery(req, purchaseQuerySchema);
  await connectDB();

  const scope = await resolveRequestScope(user, req);
  const filter: Record<string, unknown> = {
    ...pharmacyFilter(user),
    ...branchFilter(scope),
  };
  if (supplierId) filter.supplierId = new Types.ObjectId(supplierId);
  if (status !== "all") filter.status = status;
  if (paymentStatus !== "all") {
    filter.paymentStatus = paymentStatus;
    // Payment status is only meaningful once a purchase is a real liability.
    filter.status = status !== "all" ? status : "posted";
  }

  const { start, end } = dateRangeFromStrings(from, to);
  if (start || end) {
    const range: Record<string, Date> = {};
    if (start) range.$gte = start;
    if (end) range.$lt = end;
    filter.receivedDate = range;
  }

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { grnNo: pattern },
      { invoiceNo: pattern },
      { supplierName: pattern },
      { "items.medicineName": pattern },
      { "items.batchNumber": pattern },
    ];
  }

  const [docs, total, summaryAgg] = await Promise.all([
    Purchase.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Purchase.countDocuments(filter),
    // Only posted purchases count towards spend; drafts are not liabilities.
    Purchase.aggregate([
      { $match: { ...filter, status: "posted" } },
      {
        $group: {
          _id: null,
          purchased: { $sum: "$totalAmount" },
          paid: { $sum: "$amountPaid" },
          vat: { $sum: "$vatAmount" },
        },
      },
    ]),
  ]);

  const summary = (summaryAgg[0] ?? {}) as {
    purchased?: number;
    paid?: number;
    vat?: number;
  };
  const round = (value: number) => Math.round(value * 100) / 100;
  const purchased = round(summary.purchased ?? 0);
  const paid = round(summary.paid ?? 0);

  return ok(
    docs.map((purchase) => ({
      id: String(purchase._id),
      grnNo: purchase.grnNo,
      supplierId: String(purchase.supplierId),
      supplierName: purchase.supplierName,
      invoiceNo: purchase.invoiceNo ?? "",
      invoiceDate: purchase.invoiceDate,
      receivedDate: purchase.receivedDate,
      status: purchase.status,
      paymentStatus: purchase.paymentStatus,
      lineCount: purchase.items.length,
      unitCount: purchase.items.reduce(
        (sum, item) => sum + item.quantity + item.freeQuantity,
        0,
      ),
      subtotal: purchase.subtotal,
      vatAmount: purchase.vatAmount,
      totalAmount: purchase.totalAmount,
      amountPaid: purchase.amountPaid,
      dueDate: purchase.dueDate,
      createdByName: purchase.createdByName ?? "",
      createdAt: purchase.createdAt,
    })),
    {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary: {
        purchased,
        paid,
        outstanding: round(purchased - paid),
        vat: round(summary.vat ?? 0),
      },
    },
  );
});

/**
 * POST /api/purchases
 *
 * Creates a draft by default. Send `?post=1` to receive the goods in one step,
 * which is the common case when the delivery is already checked.
 *
 * This is the ONLY way stock enters the system - there is no direct batch
 * create route.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("purchase:write");
  const input = await parseJson(req, purchaseSchema);

  const postNow = new URL(req.url).searchParams.get("post") === "1";
  if (postNow) await requirePermission("purchase:post");

  const purchase = await createPurchase(input, user, postNow);
  return created(purchase);
});
