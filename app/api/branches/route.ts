import { ok, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { listBranches } from "@/lib/branches";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  includeInactive: z.enum(["0", "1"]).optional(),
});

/**
 * The shop's own view of its outlets: read, rename, close.
 *
 * There is no POST here. Opening an outlet is a platform action now - a shop
 * asks for one and superadmin creates it against that pharmacy through
 * POST /api/pharmacies/:id/branches.
 */

/** GET /api/branches - the registry, with stock and staff counts. */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("branch:manage");
  const { includeInactive } = parseQuery(req, listQuery);
  const data = await listBranches(user, includeInactive === "1");
  return ok(data);
});
