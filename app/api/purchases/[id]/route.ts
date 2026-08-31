import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { deleteDraftPurchase, updateDraftPurchase } from "@/lib/purchases";
import { Purchase } from "@/models/Purchase";
import { SupplierPayment } from "@/models/SupplierPayment";
import { objectIdSchema, purchaseSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/purchases/:id - accepts the Mongo id or the GRN number. */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("purchase:read");
  const { id } = await ctx.params;
  await connectDB();
  const scope = await resolveViewScope(user);

  const query = objectIdSchema.safeParse(id).success
    ? { _id: id }
    : { grnNo: id.toUpperCase() };

  const purchase = await Purchase.findOne(query).lean();
  if (!purchase) throw ApiError.notFound("No purchase found with that number.");
  assertVisibleInScope(purchase.branchId, scope, "No purchase found with that number.");

  const payments = await SupplierPayment.find({ purchaseId: purchase._id })
    .sort({ paidOn: -1 })
    .lean();

  return ok({
    id: String(purchase._id),
    grnNo: purchase.grnNo,
    supplierId: String(purchase.supplierId),
    supplierName: purchase.supplierName,
    invoiceNo: purchase.invoiceNo ?? "",
    invoiceDate: purchase.invoiceDate,
    receivedDate: purchase.receivedDate,
    status: purchase.status,
    paymentStatus: purchase.paymentStatus,
    items: purchase.items.map((item) => ({
      medicineId: String(item.medicineId),
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      mfgDate: item.mfgDate,
      expiryDate: item.expiryDate,
      quantity: item.quantity,
      freeQuantity: item.freeQuantity,
      costPrice: item.costPrice,
      effectiveUnitCost: item.effectiveUnitCost,
      salePrice: item.salePrice,
      discount: item.discount,
      lineTotal: item.lineTotal,
      batchId: item.batchId ? String(item.batchId) : null,
      toppedUpExisting: item.toppedUpExisting,
    })),
    subtotal: purchase.subtotal,
    discount: purchase.discount,
    otherCharges: purchase.otherCharges,
    taxableAmount: purchase.taxableAmount,
    vatRate: purchase.vatRate,
    vatAmount: purchase.vatAmount,
    totalAmount: purchase.totalAmount,
    amountPaid: purchase.amountPaid,
    dueDate: purchase.dueDate,
    notes: purchase.notes ?? "",
    createdByName: purchase.createdByName ?? "",
    postedAt: purchase.postedAt,
    cancelledAt: purchase.cancelledAt,
    cancelReason: purchase.cancelReason ?? "",
    createdAt: purchase.createdAt,
    payments: payments.map((payment) => ({
      id: String(payment._id),
      amount: payment.amount,
      method: payment.method,
      paidOn: payment.paidOn,
      reference: payment.reference ?? "",
      recordedByName: payment.recordedByName ?? "",
    })),
  });
});

/** PATCH /api/purchases/:id - drafts only; posted GRNs are immutable. */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("purchase:write");
  const { id } = await ctx.params;
  const input = await parseJson(req, purchaseSchema);

  const purchase = await updateDraftPurchase(objectIdSchema.parse(id), input, user);
  return ok(purchase);
});

/** DELETE /api/purchases/:id - drafts only; posted GRNs are cancelled. */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("purchase:write");
  const { id } = await ctx.params;

  const result = await deleteDraftPurchase(objectIdSchema.parse(id));
  return ok({ id, deleted: true, message: `${result.grnNo} was deleted.` });
});
