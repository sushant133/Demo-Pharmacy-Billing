import { cookies } from "next/headers";
import { ApiError, ok, withRoute } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { IMPERSONATION_COOKIE, config } from "@/lib/config";
import { recordPlatformEvent } from "@/lib/platform-events";
import {
  impersonationCookieOptions,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/stop-impersonation - hand the session back to the platform.
 *
 * Called from inside the shop, by the banner that has been on screen the
 * whole time. The parked platform token is verified again rather than
 * trusted: it is a cookie, and a cookie is something the browser sends, not
 * something we issued a moment ago.
 *
 * If it has expired or been tampered with there is nothing to go back to, so
 * the impersonated session is cleared and the caller is sent to sign in
 * again. Ending impersonation must never fail in a way that leaves somebody
 * still holding the owner's session.
 */
export const POST = withRoute(async () => {
  const session = await requireSession();
  const cookieStore = await cookies();

  if (!session.impersonatorId) {
    throw ApiError.badRequest("This session is not an impersonation.");
  }

  const parked = cookieStore.get(IMPERSONATION_COOKIE)?.value;
  const platform = parked ? await verifySession(parked) : null;

  await recordPlatformEvent(
    { id: session.impersonatorId, name: session.impersonatorName ?? "" },
    "impersonation.ended",
    {
      pharmacyId: session.pharmacyId || null,
      pharmacyName: session.pharmacyName,
      summary: `Stopped acting as ${session.name} at ${session.pharmacyName}.`,
    },
  );

  // Overwritten with an expiring cookie rather than deleted by name, so the
  // flags (path, secure) match the ones it was set with.
  cookieStore.set({ ...impersonationCookieOptions(0), value: "" });

  if (!platform || platform.role !== "superadmin") {
    cookieStore.set({ ...sessionCookieOptions(0), value: "" });
    return ok({ restored: false, next: "/login" });
  }

  cookieStore.set({
    ...sessionCookieOptions(config.sessionTtlSeconds),
    value: await signSession(platform),
  });

  return ok({ restored: true, next: "/superadmin" });
});
