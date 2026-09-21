import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setPharmacyStatus } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema, pharmacyStatusSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/pharmacies/:id/activate - restore a suspended pharmacy. */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;

  const raw = await req.json().catch(() => ({}));
  const parsed = pharmacyStatusSchema.safeParse(raw ?? {});
  const reason = parsed.success ? parsed.data.reason : "";

  const pharmacy = await setPharmacyStatus(
    objectIdSchema.parse(id),
    "active",
    reason,
  );

  await recordPlatformEvent(actor, "pharmacy.activated", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Activated ${pharmacy.name}. Its logins work again.`,
    detail: reason,
  });

  return ok(pharmacy);
});
