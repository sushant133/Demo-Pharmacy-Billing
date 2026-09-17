import { SignJWT, jwtVerify } from "jose";
import { SESSION_COOKIE, config, requireAuthSecret } from "@/lib/config";
import { ROLE_SCHEME_VERSION, normalizeRole, type Role } from "@/lib/roles";

/**
 * Stateless session tokens (HS256 JWT) stored in an httpOnly cookie.
 *
 * `jose` is used rather than `jsonwebtoken` because it runs on the Edge
 * runtime, which lets middleware verify a session without a Node process or a
 * database round trip.
 *
 * This module must stay free of Node-only and Mongoose imports so middleware
 * can import it.
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Empty for the platform superadmin, who belongs to no pharmacy. */
  pharmacyId: string;
  pharmacyName: string;
  pharmacySlug: string;
  /** The outlet the user physically works at; where their stock moves. */
  branchId: string;
  branchCode: string;
  branchName: string;
}

const encoder = new TextEncoder();

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function secretKey(): Uint8Array {
  return encoder.encode(requireAuthSecret());
}

export async function signSession(user: SessionUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    name: user.name,
    email: user.email,
    role: user.role,
    // The role scheme this token was signed under. Without it a cookie
    // holding "cashier" is ambiguous: under scheme 1 that word meant the
    // owner, under scheme 2 it means an actual cashier. See lib/roles.ts.
    rv: ROLE_SCHEME_VERSION,
    pharmacyId: user.pharmacyId,
    pharmacyName: user.pharmacyName,
    pharmacySlug: user.pharmacySlug,
    branchId: user.branchId,
    branchCode: user.branchCode,
    branchName: user.branchName,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + config.sessionTtlSeconds)
    .setIssuer("mantrapharma")
    .setAudience("mantrapharma:web")
    .sign(secretKey());
}

/** Verify a token. Returns null for anything invalid, expired or malformed. */
export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: "mantrapharma",
      audience: "mantrapharma:web",
      algorithms: ["HS256"],
    });

    // A cookie signed before narrower roles existed carries no `rv`, and
    // `normalizeRole` reads its role under the old meaning - so a shift in
    // progress is neither ended nor quietly demoted by a deploy.
    const role = normalizeRole(payload.role, payload.rv);
    if (!payload.sub || !role) return null;

    return {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "",
      email: typeof payload.email === "string" ? payload.email : "",
      role,
      pharmacyId: str(payload.pharmacyId),
      pharmacyName: str(payload.pharmacyName),
      pharmacySlug: str(payload.pharmacySlug),
      branchId: str(payload.branchId),
      branchCode: str(payload.branchCode),
      branchName: str(payload.branchName),
    };
  } catch {
    return null;
  }
}

/** Cookie options shared by the login and logout routes. */
export function sessionCookieOptions(maxAge: number) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax" as const,
    // Cloudflare/nginx terminate TLS, so the app itself sees http in prod.
    // Secure is still correct here: the browser only ever sees https.
    secure: config.isProd,
    path: "/",
    maxAge,
  };
}

export { SESSION_COOKIE };
