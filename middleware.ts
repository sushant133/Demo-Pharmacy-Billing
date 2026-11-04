import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { BACKGROUND_PATHS, auditorMayWrite, idleLimitApplies } from "@/lib/request-rules";
import {
  SESSION_COOKIE,
  SIGNED_OUT_COOKIE,
  isIdleExpired,
  isSignedOutSession,
  sessionCookieOptions,
  signSession,
  verifySession,
  type SessionUser,
} from "@/lib/session";
import { ROUTE_PERMISSIONS, can, homePath } from "@/lib/roles";

/**
 * Edge middleware: the first gate every request passes through.
 *
 * It verifies the session JWT signature without a database round trip, which
 * keeps unauthenticated traffic off the app entirely. Route handlers still
 * re-check permissions themselves - middleware is a fast filter, never the
 * only line of defence.
 */

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  /*
    Password recovery, necessarily. Somebody who has forgotten their password
    cannot sign in to ask for a reset, so both screens and both endpoints have
    to be reachable without a session. They are safe to expose: neither says
    whether an address has an account, and the reset token is the credential.
    See lib/password-reset.ts.
  */
  "/forgot-password",
  "/reset-password",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/manifest.webmanifest",
  "/icon",
  // The PWA worker and its offline page: fetched before anyone signs in, and
  // a redirect to /login in their place makes the site uninstallable.
  "/sw.js",
  "/offline.html",
  // Polled by the Android app before anyone has signed in.
  "/android-app-version.json",
  // Play Console and anyone deciding whether to use the app read it signed out.
  "/privacy",
  // Called by an external scheduler with its own bearer secret, not a session.
  "/api/cbms/run",
];

/** Where a user signed in on a temporary password is held until they replace it. */
const CHANGE_PASSWORD_PATH = "/change-password";

/** Re-sign the cookie at most this often while someone is working. */
const ACTIVITY_REFRESH_SECONDS = 60;

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(path + "/"),
  );
}

function isPlatformPath(pathname: string): boolean {
  return (
    pathname === "/superadmin" ||
    pathname.startsWith("/superadmin/") ||
    pathname === "/api/pharmacies" ||
    pathname.startsWith("/api/pharmacies/")
  );
}

function isShopAppPath(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return false;
  if (isPlatformPath(pathname)) return false;
  if (pathname.startsWith("/api/")) return true;
  return (
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/billing") ||
    pathname.startsWith("/sales") ||
    pathname.startsWith("/invoices") ||
    pathname.startsWith("/prescriptions") ||
    pathname.startsWith("/medicines") ||
    pathname.startsWith("/batches") ||
    pathname.startsWith("/inventory") ||
    pathname.startsWith("/customers") ||
    pathname.startsWith("/suppliers") ||
    pathname.startsWith("/purchases") ||
    pathname.startsWith("/reports") ||
    pathname.startsWith("/expenses") ||
    pathname.startsWith("/payments") ||
    pathname.startsWith("/payables") ||
    pathname.startsWith("/alerts") ||
    pathname.startsWith("/staff") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/cbms") ||
    pathname.startsWith("/branches") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/bills/") ||
    // Credit notes sit beside bills rather than inside the app shell: both are
    // documents to print, not screens to work in.
    pathname.startsWith("/returns/")
  );
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const presented = token ? await verifySession(token) : null;
  // A session signed out in this browser stays out, even if a response already
  // on its way when they clicked Sign out has put the cookie back.
  const signedOut =
    presented != null && isSignedOutSession(presented, req.cookies.get(SIGNED_OUT_COOKIE)?.value);
  const verified = signedOut ? null : presented;

  /*
    Idle timeout. A token is valid for a whole shift, but a till left signed in
    over lunch should not be. Past the idle limit the session is treated as
    gone: the cookie is cleared and the user sees the sign-in screen with a
    note saying why.
  */
  if (
    verified &&
    idleLimitApplies(pathname) &&
    isIdleExpired(verified, appConfig.idleTimeoutSeconds)
  ) {
    let response: NextResponse;
    if (isPublic(pathname)) {
      response = NextResponse.next();
    } else if (pathname.startsWith("/api/")) {
      response = NextResponse.json(
        {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "You were signed out after a period of inactivity. Please sign in again.",
          },
        },
        { status: 401 },
      );
    } else {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("expired", "1");
      if (pathname !== "/") loginUrl.searchParams.set("next", pathname + search);
      response = NextResponse.redirect(loginUrl);
    }
    response.cookies.set({ ...sessionCookieOptions(0), value: "" });
    return response;
  }

  const response = await gate(req, verified);
  if (signedOut) {
    response.cookies.set({ ...sessionCookieOptions(0), value: "" });
    return response;
  }

  // Sliding activity: push the idle clock forward while someone is working,
  // keeping the token's original expiry so a shift still ends.
  if (
    verified &&
    token &&
    !isPublic(pathname) &&
    !BACKGROUND_PATHS.includes(pathname) &&
    response.status < 400
  ) {
    const now = Math.floor(Date.now() / 1000);
    const remaining = (verified.expiresAt ?? 0) - now;
    if (now - (verified.lastActiveAt ?? 0) >= ACTIVITY_REFRESH_SECONDS && remaining > 0) {
      const fresh = await signSession(verified, remaining);
      response.cookies.set({ ...sessionCookieOptions(remaining), value: fresh });
    }
  }

  return response;
}

async function gate(req: NextRequest, session: SessionUser | null): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  // Already signed in and heading for the login page - send them to work.
  if (session && pathname === "/login") {
    return NextResponse.redirect(new URL(homePath(session.role), req.url));
  }

  if (isPublic(pathname)) return NextResponse.next();

  if (!session) {
    // API callers get JSON in the same envelope as every other error; browsers
    // get a redirect that remembers where they were going.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "You must be signed in to do that." },
        },
        { status: 401 },
      );
    }

    const loginUrl = new URL("/login", req.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  /*
    Signed in on a temporary password - the one generated when the pharmacy
    was opened and emailed to the owner. Until they choose their own, the only
    things they can reach are the screen that does that, the endpoint behind
    it, and the way out. The API answers in the usual envelope so a client
    polling in the background gets something it can read.
  */
  if (session.mustChangePassword) {
    const allowed =
      pathname === CHANGE_PASSWORD_PATH ||
      pathname === "/api/auth/change-password" ||
      pathname === "/api/auth/me";
    if (!allowed) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "PASSWORD_CHANGE_REQUIRED",
              message: "Choose a new password before continuing.",
            },
          },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL(CHANGE_PASSWORD_PATH, req.url));
    }
    return NextResponse.next();
  }

  /*
    `/` is the app's launch URL. app/page.tsx makes the same redirect, but
    only after a server render; answering here from the cookie saves that
    round trip on every cold start of the Android app.
  */
  if (pathname === "/") {
    return NextResponse.redirect(new URL(homePath(session.role), req.url));
  }

  // Nothing to change: send anyone who wanders onto the screen back to work.
  if (pathname === CHANGE_PASSWORD_PATH) {
    return NextResponse.redirect(new URL(homePath(session.role), req.url));
  }

  // Superadmin stays on the platform; pharmacy owners stay in their shop.
  if (session.role === "superadmin" && isShopAppPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "The platform administrator cannot operate a pharmacy till.",
          },
        },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/superadmin", req.url));
  }

  if (session.role !== "superadmin" && isPlatformPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "Only the platform administrator can manage pharmacies.",
          },
        },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL(homePath(session.role), req.url));
  }

  // An IRD auditor reads everything they are given and changes nothing. The
  // handlers already refuse writes for want of permission; this makes the
  // rule hold even for an endpoint that forgets to ask.
  if (
    session.role === "auditor" &&
    pathname.startsWith("/api/") &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !auditorMayWrite(pathname)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "FORBIDDEN", message: "Auditor access is read-only." },
      },
      { status: 403 },
    );
  }

  // Coarse per-screen role gate. Fine-grained checks live in the handlers.
  const rule = ROUTE_PERMISSIONS.find((entry) => pathname.startsWith(entry.prefix));
  if (rule && !can(session.role, rule.permission)) {
    const fallback = session.role === "superadmin" ? "/superadmin" : "/dashboard?denied=1";
    return NextResponse.redirect(new URL(fallback, req.url));
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)",
  ],
};
