import { created, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { writeOffAllExpired } from "@/lib/stock-movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/expired - write off every expired lot on the shelf in
 * the branch scope being viewed. One ledger line per lot, reason "Expired".
 */
export const POST = withRoute(async () => {
  const user = await requirePermission("batch:write");
  const scope = await resolveViewScope(user);
  return created(await writeOffAllExpired(user, branchFilter(scope)));
});
