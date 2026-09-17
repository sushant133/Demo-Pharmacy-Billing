import { created, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { createStaff } from "@/lib/staff";
import { staffSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/staff - issue a login for a colleague at this pharmacy. */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("user:manage");
  const input = await parseJson(req, staffSchema);

  return created(await createStaff(user, input));
});
