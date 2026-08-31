import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchFilter, resolveRequestScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { dateRangeFromStrings } from "@/lib/dates";
import { createSale } from "@/lib/sales";
import { Sale } from "@/models/Sale";
import { createSaleSchema, salesQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sales
 * Query: from, to (YYYY-MM-DD, inclusive), paymentMode, q, page, pageSize
 *
 * Date bounds are resolved in the business timezone, so "today" means today
 * in Kathmandu even though the VPS clock runs on UTC.
 */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("sale:read");
  const { from, to, paymentMode, q, page, pageSize } = parseQuery(
    req,
    salesQuerySchema,
  );
  await connectDB();

  const scope = await resolveRequestScope(user, req);
  const filter: Record<string, unknown> = { ...branchFilter(scope) };
  const { start, end } = dateRangeFromStrings(from, to);

  if (start || end) {
    const range: Record<string, Date> = {};
    if (start) range.$gte = start;
    if (end) range.$lt = end;
    filter.createdAt = range;
  }

  if (paymentMode) filter.paymentMode = paymentMode;

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { billNo: pattern },
      { customerName: pattern },
      { "items.medicineName": pattern },
    ];
  }

  const [docs, total, totalsAgg] = await Promise.all([
    Sale.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Sale.countDocuments(filter),
    // Totals cover the whole filtered range, not just the current page - the
    // sales screen shows "period total", which must not change as you page.
    Sale.aggregate([
      { $match: { ...filter, voidedAt: null } },
      {
        $group: {
          _id: null,
          grossTotal: { $sum: "$totalAmount" },
          vatTotal: { $sum: "$vatAmount" },
          discountTotal: { $sum: "$discount" },
        },
      },
    ]),
  ]);

  const totals = (totalsAgg[0] ?? {}) as {
    grossTotal?: number;
    vatTotal?: number;
    discountTotal?: number;
  };
  const round = (value: number) => Math.round(value * 100) / 100;

  const data = docs.map((sale) => ({
    id: String(sale._id),
    billNo: sale.billNo,
    customerId: sale.customerId ? String(sale.customerId) : null,
    customerName: sale.customerName ?? "",
    itemCount: sale.items.reduce((sum, item) => sum + item.quantity, 0),
    lineCount: sale.items.length,
    subtotal: sale.subtotal,
    discount: sale.discount,
    vatAmount: sale.vatAmount,
    totalAmount: sale.totalAmount,
    paymentMode: sale.paymentMode,
    soldByName: sale.soldByName ?? "",
    voided: Boolean(sale.voidedAt),
    createdAt: sale.createdAt,
  }));

  return ok(data, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      grossTotal: round(totals.grossTotal ?? 0),
      vatTotal: round(totals.vatTotal ?? 0),
      discountTotal: round(totals.discountTotal ?? 0),
      billCount: total,
    },
  });
});

/**
 * POST /api/sales - complete a sale.
 *
 * Accepts only { medicineId, quantity } per line: batch choice is the
 * system's job, not the cashier's, which is the whole point of FEFO.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("sale:create");
  const input = await parseJson(req, createSaleSchema);
  await connectDB();

  const sale = await createSale(input, user);
  return created(sale);
});

