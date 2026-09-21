import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createBranchForPharmacy, listBranchesForPharmacy } from "@/lib/branches";
import { getPharmacy } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { branchSchema, objectIdSchema } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Outlets of one pharmacy, from the platform side.
 *
 * A shop can no longer open its own outlet: it asks the platform, and
 * superadmin opens it here against the pharmacy that asked. The shop then
 * runs it - renaming, making it the default and closing it stay on
 * /api/branches, where the tenant's own `branch:manage` permission applies.
 */

type Ctx = { params: Promise<{ id: string }> };

const listQuery = z.object({
  includeInactive: z.enum(["0", "1"]).optional(),
});

async function pharmacyId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/pharmacies/:id/branches - that shop's outlets, closed ones too. */
export const GET = withRoute<Ctx>(async (req, ctx) => {
  await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  const { includeInactive } = parseQuery(req, listQuery);
  return ok(await listBranchesForPharmacy(id, includeInactive !== "0"));
});

/** POST /api/pharmacies/:id/branches - open an outlet for that shop. */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  const input = await parseJson(req, branchSchema);

  const branch = await createBranchForPharmacy(id, input);
  const pharmacy = await getPharmacy(id);

  await recordPlatformEvent(actor, "branch.created", {
    pharmacyId: id,
    pharmacyName: pharmacy.name,
    summary: `Opened the ${branch.name} outlet for ${pharmacy.name}.`,
    detail: `Branch code ${branch.code}.`,
  });

  return created(branch);
});
