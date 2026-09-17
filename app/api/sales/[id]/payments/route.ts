import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { receiveSalePayment } from "@/lib/sales";
import { receiveSalePaymentSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/:id/payments - take money against an outstanding bill.
 *
 * The other half of a credit or part-paid sale. Appends to that bill's payment
 * ledger and recomputes its status; it never edits a balance, so how a debt
 * was cleared stays on the record.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("payment:write");
  const { id } = await ctx.params;
  const input = await parseJson(req, receiveSalePaymentSchema);

  return created(await receiveSalePayment(id, input, user));
});
