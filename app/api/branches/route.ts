import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createBranch, listBranches } from "@/lib/branches";
import { branchSchema } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  includeInactive: z.enum(["0", "1"]).optional(),
});

/** GET /api/branches - the registry, with stock and staff counts. */
export const GET = withRoute(async (req) => {
  await requirePermission("branch:manage");
  const { includeInactive } = parseQuery(req, listQuery);
  const data = await listBranches(includeInactive === "1");
  return ok(data);
});

/** POST /api/branches - open a new outlet. */
export const POST = withRoute(async (req) => {
  await requirePermission("branch:manage");
  const input = await parseJson(req, branchSchema);
  const branch = await createBranch(input);
  return created(branch);
});
