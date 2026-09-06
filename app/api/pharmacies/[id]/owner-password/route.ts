import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resetOwnerPassword } from "@/lib/pharmacies";
import { objectIdSchema, resetOwnerPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/pharmacies/:id/owner-password - set a new owner password. */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const { password } = await parseJson(req, resetOwnerPasswordSchema);
  await resetOwnerPassword(objectIdSchema.parse(id), password);
  return ok({ reset: true });
});
