import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createPrescription } from "@/lib/prescriptions";
import { prescriptionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/prescriptions - file a doctor's prescription.
 *
 * Gated on `sale:create`: filing a script is part of serving a customer, and a
 * role that cannot bill has no reason to be recording what was prescribed.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("sale:create");
  const input = await parseJson(req, prescriptionSchema);

  return created(await createPrescription(user, input));
});
