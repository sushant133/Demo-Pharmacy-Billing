import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { deleteBranchForPharmacy } from "@/lib/branches";
import { getPharmacy } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { deleteBranchSchema, objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; branchId: string }> };

/**
 * DELETE /api/pharmacies/:id/branches/:branchId - remove an outlet for good.
 *
 * The counterpart to opening one, and the thing the shop itself cannot do.
 * A pharmacy closes an outlet it has finished with, which keeps its bills
 * reprintable; this removes one that should never have existed - opened with
 * the wrong code, or against the wrong pharmacy.
 *
 * Guarded in the service: the branch must not be the default, nothing may
 * point at it, and its code has to be typed by hand. The event is written
 * after the deletion rather than before, because a row describing a removal
 * that did not happen is worse than no row.
 */
export const DELETE = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id, branchId } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);
  const outletId = objectIdSchema.parse(branchId);

  const { confirm } = await parseJson(req, deleteBranchSchema);

  const pharmacy = await getPharmacy(pharmacyId);
  const branch = await deleteBranchForPharmacy(pharmacyId, outletId, confirm);

  await recordPlatformEvent(actor, "branch.deleted", {
    pharmacyId,
    pharmacyName: pharmacy.name,
    summary: `Deleted the ${branch.name} outlet of ${pharmacy.name}.`,
    detail: `Branch code ${branch.code}. It held no stock, bills or staff.`,
  });

  return ok(branch);
});
