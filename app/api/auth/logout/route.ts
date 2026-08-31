import { cookies } from "next/headers";
import { ok, withRoute } from "@/lib/api";
import { sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout - clear the session cookie. */
export const POST = withRoute(async () => {
  const cookieStore = await cookies();
  // Overwrite with an immediately-expiring cookie so the browser drops it.
  cookieStore.set({ ...sessionCookieOptions(0), value: "" });
  return ok({ signedOut: true });
});
