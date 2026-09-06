import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getPharmacy, updatePharmacy } from "@/lib/pharmacies";
import { objectIdSchema, updatePharmacySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function pharmacyId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/pharmacies/:id */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  return ok(await getPharmacy(id));
});

/** PATCH /api/pharmacies/:id - name and notes. Status has its own routes. */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  const input = await parseJson(req, updatePharmacySchema);
  return ok(await updatePharmacy(id, input));
});
