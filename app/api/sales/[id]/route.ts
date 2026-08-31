import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { Sale } from "@/models/Sale";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sales/:id - one bill, with every dispensed line. */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("sale:read");
  const { id } = await ctx.params;
  await connectDB();
  const scope = await resolveViewScope(user);

  // Accept either the Mongo id or the human bill number, so a staff member can
  // look a bill up by the number printed on the customer's copy.
  const query = objectIdSchema.safeParse(id).success
    ? { _id: id }
    : { billNo: id.toUpperCase() };

  const sale = await Sale.findOne(query).lean();
  if (!sale) throw ApiError.notFound("No bill found with that number.");
  assertVisibleInScope(sale.branchId, scope, "No bill found with that number.");

  return ok({
    id: String(sale._id),
    billNo: sale.billNo,
    customerId: sale.customerId ? String(sale.customerId) : null,
    customerName: sale.customerName ?? "",
    items: sale.items.map((item) => ({
      medicineId: String(item.medicineId),
      batchId: String(item.batchId),
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    discountPercent: sale.discountPercent ?? 0,
    taxableAmount: sale.taxableAmount,
    vatRate: sale.vatRate,
    vatAmount: sale.vatAmount,
    totalAmount: sale.totalAmount,
    paymentMode: sale.paymentMode,
    soldByName: sale.soldByName ?? "",
    branch: sale.branchName || "—",
    branchName: sale.branchName || "—",
    note: sale.note ?? "",
    voided: Boolean(sale.voidedAt),
    voidedAt: sale.voidedAt ?? null,
    voidedByName: sale.voidedByName ?? "",
    voidReason: sale.voidReason ?? "",
    createdAt: sale.createdAt,
  });
});
