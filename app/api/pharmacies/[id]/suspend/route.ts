import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setPharmacyStatus } from "@/lib/pharmacies";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/pharmacies/:id/suspend - owner can no longer sign in. */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacy = await setPharmacyStatus(objectIdSchema.parse(id), "suspended");
  return ok(pharmacy);
});
