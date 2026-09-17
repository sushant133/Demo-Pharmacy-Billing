import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { getSupplierBalance } from "@/lib/suppliers";
import { Batch } from "@/models/Batch";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { objectIdSchema, supplierUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function supplierId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/suppliers/:id - the supplier plus its derived ledger position. */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("supplier:read");
  const id = await supplierId(ctx);
  await connectDB();

  const supplier = await Supplier.findOne({ _id: id, ...pharmacyFilter(user) }).lean();
  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");

  const balance = await getSupplierBalance(id, pharmacyObjectId(user));

  /*
    The posted invoices still owing something, oldest first.

    Returned alongside the balance so a payment form can attach the money to
    the bill it settles rather than dropping everything on account - which is
    what keeps the payables ledger able to answer "which invoice is overdue?"
    instead of only "how much do we owe them in total?".
  */
  const openInvoices = await Purchase.find({
    supplierId: id,
    ...pharmacyFilter(user),
    status: "posted",
    $expr: { $gt: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] },
  })
    .sort({ invoiceDate: 1, createdAt: 1 })
    .select("grnNo totalAmount amountPaid dueDate")
    .limit(100)
    .lean();

  return ok({
    id: String(supplier._id),
    ...supplier,
    balance,
    openInvoices: openInvoices.map((purchase) => ({
      id: String(purchase._id),
      grnNo: purchase.grnNo,
      outstanding:
        Math.round((purchase.totalAmount - (purchase.amountPaid ?? 0)) * 100) / 100,
      dueDate: purchase.dueDate ?? null,
    })),
  });
});

/** PATCH /api/suppliers/:id */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("supplier:write");
  const id = await supplierId(ctx);
  const update = await parseJson(req, supplierUpdateSchema);
  await connectDB();

  const supplier = await Supplier.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    update,
    {
    new: true,
    runValidators: true,
  }).lean();
  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");

  return ok({ id: String(supplier._id), ...supplier });
});

/**
 * DELETE /api/suppliers/:id - admin only.
 *
 * A supplier with purchase history is deactivated rather than deleted: their
 * GRNs are the provenance record for stock currently on the shelf, and
 * removing them would orphan every batch that came from them.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("supplier:delete");
  const id = await supplierId(ctx);
  await connectDB();

  const supplier = await Supplier.findOne({ _id: id, ...pharmacyFilter(user) });
  if (!supplier) throw ApiError.notFound("That supplier no longer exists.");

  const [purchaseCount, batchCount] = await Promise.all([
    Purchase.countDocuments({ supplierId: id, ...pharmacyFilter(user) }),
    Batch.countDocuments({ supplierId: id, ...pharmacyFilter(user) }),
  ]);

  if (purchaseCount > 0 || batchCount > 0) {
    supplier.isActive = false;
    await supplier.save();

    return ok({
      id,
      deleted: false,
      deactivated: true,
      message: `${supplier.name} has ${purchaseCount} purchase(s) and ${batchCount} batch(es) on record, so they were marked inactive instead of deleted. New purchases from them are now blocked.`,
    });
  }

  await supplier.deleteOne();
  return ok({
    id,
    deleted: true,
    deactivated: false,
    message: `${supplier.name} was deleted.`,
  });
});
