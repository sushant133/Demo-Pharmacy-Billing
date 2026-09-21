import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setPharmacyStatus } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema, pharmacyStatusSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/pharmacies/:id/suspend - owner can no longer sign in.
 *
 * The body carrying a reason is optional, and parsed defensively for the same
 * reason posting a purchase is: a reason is worth asking for, never worth
 * refusing an urgent suspension over.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;

  const raw = await req.json().catch(() => ({}));
  const parsed = pharmacyStatusSchema.safeParse(raw ?? {});
  const reason = parsed.success ? parsed.data.reason : "";

  const pharmacy = await setPharmacyStatus(
    objectIdSchema.parse(id),
    "suspended",
    reason,
  );

  await recordPlatformEvent(actor, "pharmacy.suspended", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Suspended ${pharmacy.name}. Every login for that shop is blocked.`,
    detail: reason,
  });

  return ok(pharmacy);
});
