import { created, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { recordPayment } from "@/lib/suppliers";
import { SupplierPayment } from "@/models/SupplierPayment";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema, supplierPaymentSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/suppliers/:id/payments - payment history, newest first. */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("supplier:read");
  const { id } = await ctx.params;
  const supplierId = objectIdSchema.parse(id);
  await connectDB();

  const payments = await SupplierPayment.find({
    supplierId,
    ...pharmacyFilter(user),
  })
    .sort({ paidOn: -1, createdAt: -1 })
    .limit(200)
    .lean();

  return ok(
    payments.map((payment) => ({
      id: String(payment._id),
      purchaseId: payment.purchaseId ? String(payment.purchaseId) : null,
      grnNo: payment.grnNo ?? "",
      amount: payment.amount,
      method: payment.method,
      paidOn: payment.paidOn,
      reference: payment.reference ?? "",
      note: payment.note ?? "",
      recordedByName: payment.recordedByName ?? "",
      createdAt: payment.createdAt,
    })),
  );
});

/**
 * POST /api/suppliers/:id/payments
 *
 * Pass `purchaseId` to settle a specific invoice, or omit it to pay on account
 * against the supplier's overall balance.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("payment:write");
  const { id } = await ctx.params;
  const supplierId = objectIdSchema.parse(id);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = supplierPaymentSchema.parse({ ...body, supplierId });

  const payment = await recordPayment(input, user);
  return created(payment);
});
