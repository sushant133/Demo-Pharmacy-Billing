import { cookies } from "next/headers";
import { ok, withRoute } from "@/lib/api";
import { impersonationCookieOptions, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout - clear the session cookie. */
export const POST = withRoute(async () => {
  const cookieStore = await cookies();
  // Overwrite with an immediately-expiring cookie so the browser drops it.
  cookieStore.set({ ...sessionCookieOptions(0), value: "" });
  // And the parked platform session, if signing out ends an impersonation.
  // Leaving it behind would keep a superadmin token in the browser of
  // somebody who has just signed out of everything.
  cookieStore.set({ ...impersonationCookieOptions(0), value: "" });
  return ok({ signedOut: true });
});
