import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { resetStaffPassword } from "@/lib/staff";
import { staffPasswordResetSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/staff/:id/password - set a colleague's password.
 *
 * The old password is not asked for: this is an owner resetting an account for
 * somebody who has forgotten theirs. Changing your own is a different act and
 * needs the current-password check this does not have.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("user:manage");
  const { id } = await ctx.params;
  const { password } = await parseJson(req, staffPasswordResetSchema);

  return ok(await resetStaffPassword(user, id, password));
});
