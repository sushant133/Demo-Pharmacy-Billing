import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { cancelPrescription } from "@/lib/prescriptions";
import { cancelPrescriptionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/prescriptions/:id/cancel - withdraw a script.
 *
 * Cancelled, never deleted: the number was issued, and a script that was part
 * dispensed and then withdrawn is exactly the case an inspector asks about.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("sale:void");
  const { id } = await ctx.params;
  const { reason } = await parseJson(req, cancelPrescriptionSchema);

  return ok(await cancelPrescription(user, id, reason));
});
