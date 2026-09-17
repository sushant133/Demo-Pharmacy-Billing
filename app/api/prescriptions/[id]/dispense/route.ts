import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { dispensePrescription } from "@/lib/prescriptions";
import { dispensePrescriptionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/prescriptions/:id/dispense - hand part or all of a script over.
 *
 * Appends to the script's dispense log and recomputes what is outstanding; it
 * never edits a running total, so how a script was filled stays on the record.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("sale:create");
  const { id } = await ctx.params;
  const input = await parseJson(req, dispensePrescriptionSchema);

  return created(await dispensePrescription(user, id, input));
});
