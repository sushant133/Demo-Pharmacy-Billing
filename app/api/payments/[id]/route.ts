import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { deletePayment } from "@/lib/suppliers";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/payments/:id
 *
 * Removing a payment re-derives the affected invoice's paid amount from the
 * remaining records, so the ledger stays consistent without any running total
 * being adjusted by hand.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("payment:write");
  const { id } = await ctx.params;
  await deletePayment(objectIdSchema.parse(id), user);
  return ok({ id, deleted: true });
});
