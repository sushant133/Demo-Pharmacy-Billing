import { ok, withRoute } from "@/lib/api";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/me - the current session, for client-side role checks. */
export const GET = withRoute(async () => {
  const user = await requireSession();
  return ok({ user });
});
