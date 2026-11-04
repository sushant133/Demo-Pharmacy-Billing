import { ok, withRoute } from "@/lib/api";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/activity - "still here".
 *
 * Does nothing itself. Middleware moves the idle clock forward on any request
 * a person made, and this is the request components/IdleSignOut.tsx makes
 * while someone types into a form that has not called the server yet.
 */
export const POST = withRoute(async () => {
  await requireSession();
  return ok({ active: true });
});
