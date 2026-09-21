import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getPharmacy, resetOwnerPassword } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema, resetOwnerPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/pharmacies/:id/owner-password - set a new owner password. */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);
  const { password } = await parseJson(req, resetOwnerPasswordSchema);

  await resetOwnerPassword(pharmacyId, password);
  const pharmacy = await getPharmacy(pharmacyId);

  // The password itself is never recorded - only that it was changed, by
  // whom, and for which login.
  await recordPlatformEvent(actor, "owner.password-reset", {
    pharmacyId,
    pharmacyName: pharmacy.name,
    summary: `Reset the owner password for ${pharmacy.ownerEmail}.`,
  });

  return ok({ reset: true });
});
