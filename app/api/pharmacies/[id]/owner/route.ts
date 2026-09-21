import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getPharmacy, updatePharmacyOwner } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema, updateOwnerSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/pharmacies/:id/owner - who the owner login belongs to.
 *
 * The shop changing hands, or an owner moving to a new address, without
 * creating a second pharmacy and stranding the first one's data. The old
 * address is read before the write so the audit trail records what it was.
 */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);
  const input = await parseJson(req, updateOwnerSchema);

  const before = await getPharmacy(pharmacyId);
  const pharmacy = await updatePharmacyOwner(pharmacyId, input);

  await recordPlatformEvent(actor, "owner.updated", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Changed the owner login for ${pharmacy.name}.`,
    detail:
      before.ownerEmail === pharmacy.ownerEmail
        ? `Renamed to ${pharmacy.ownerName}.`
        : `${before.ownerEmail || "(none)"} to ${pharmacy.ownerEmail}.`,
  });

  return ok(pharmacy);
});
