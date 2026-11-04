import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { cbmsCounts, queueNeverQueuedBills, syncDueCbms } from "@/lib/cbms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cbms/retry - send everything this pharmacy still owes IRD, now.
 *
 * The "Send now" button on the CBMS screen. The background runner does the
 * same on a timer; this is for an owner who has just fixed their CBMS login,
 * or whose internet has just come back, and does not want to wait.
 */
export const POST = withRoute(async () => {
  const user = await requirePermission("settings:manage");
  // Bills from before everything was queued join the backlog first, oldest out.
  await queueNeverQueuedBills(user.pharmacyId);
  // A big backlog takes several presses, and the count on the screen shows how many.
  const attempted = await syncDueCbms({
    pharmacyId: user.pharmacyId,
    force: true,
    limit: 200,
    budgetMs: 45_000,
  });
  const counts = await cbmsCounts(user.pharmacyId);
  return ok({ attempted, counts });
});
