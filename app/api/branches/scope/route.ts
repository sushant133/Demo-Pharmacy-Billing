import { cookies } from "next/headers";
import { ok, parseJson, withRoute } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import {
  ALL_BRANCHES,
  BRANCH_COOKIE,
  canSwitchBranch,
  resolveViewScope,
} from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { branchScopeBodySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/branches/scope - set the admin viewing-scope cookie.
 *
 * Non-admins are pinned to their own branch; the cookie is ignored for them
 * and we still succeed so a stale client does not error.
 */
export const POST = withRoute(async (req) => {
  const user = await requireSession();
  const { branch } = await parseJson(req, branchScopeBodySchema);

  const cookieStore = await cookies();
  if (canSwitchBranch(user)) {
    cookieStore.set({
      name: BRANCH_COOKIE,
      value: branch === ALL_BRANCHES || branch === "all" ? ALL_BRANCHES : branch,
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  const scope = await resolveViewScope(user, branch);
  return ok({
    code: scope.code,
    label: scope.label,
    switchable: scope.switchable,
  });
});
