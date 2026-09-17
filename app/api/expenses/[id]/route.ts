import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { deleteExpense, updateExpense } from "@/lib/expenses";
import { expenseUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/expenses/:id - correct a recorded cost. */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("report:financial");
  const { id } = await ctx.params;
  const input = await parseJson(req, expenseUpdateSchema);

  return ok(await updateExpense(user, id, input));
});

/**
 * DELETE /api/expenses/:id - remove a cost entered in error.
 *
 * A real delete, unlike a stock movement or a receipt. An expense row is
 * bookkeeping rather than a claim about something that physically happened, so
 * a reversing entry would only make the category totals harder to read.
 */
export const DELETE = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("report:financial");
  const { id } = await ctx.params;

  return ok(await deleteExpense(user, id));
});
