import { cookies } from "next/headers";
import { ok, withRoute } from "@/lib/api";
import { recordSecurityEvent } from "@/lib/audit";
import { getSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/config";
import {
  impersonationCookieOptions,
  sessionCookieOptions,
  signedOutCookieOptions,
  verifySession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout - clear the session cookie. */
export const POST = withRoute(async () => {
  // Read before the cookie is cleared, so the entry names who signed out.
  if (await getSession()) await recordSecurityEvent({ action: "logout" });
  const cookieStore = await cookies();
  // Remember which session this was, for as long as its token could still be
  // valid, in case a response already on its way restores the cookie.
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const ended = token ? await verifySession(token) : null;
  const remaining = (ended?.expiresAt ?? 0) - Math.floor(Date.now() / 1000);
  if (ended && remaining > 0) {
    cookieStore.set({ ...signedOutCookieOptions(remaining), value: String(ended.expiresAt) });
  }
  // Overwrite with an immediately-expiring cookie so the browser drops it.
  cookieStore.set({ ...sessionCookieOptions(0), value: "" });
  // And the parked platform session, if signing out ends an impersonation.
  // Leaving it behind would keep a superadmin token in the browser of
  // somebody who has just signed out of everything.
  cookieStore.set({ ...impersonationCookieOptions(0), value: "" });
  return ok({ signedOut: true });
});
