import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
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
  // Polled by the Android app before anyone has signed in.
  "/android-app-version.json",
];

/** Where a user signed in on a temporary password is held until they replace it. */
const CHANGE_PASSWORD_PATH = "/change-password";

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
  const session = token ? await verifySession(token) : null;

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
