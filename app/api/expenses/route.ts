import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createExpense } from "@/lib/expenses";
import { expenseSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/expenses - record a running cost that is not stock. */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("report:financial");
  const input = await parseJson(req, expenseSchema);

  return created(await createExpense(user, input));
});
