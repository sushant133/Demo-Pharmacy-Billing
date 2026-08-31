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

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(path + "/"),
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

  // Coarse per-screen role gate. Fine-grained checks live in the handlers.
  const rule = ROUTE_PERMISSIONS.find((entry) => pathname.startsWith(entry.prefix));
  if (rule && !can(session.role, rule.permission)) {
    return NextResponse.redirect(new URL("/dashboard?denied=1", req.url));
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
