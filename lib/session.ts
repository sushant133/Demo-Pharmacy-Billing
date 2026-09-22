import { SignJWT, jwtVerify } from "jose";
import {
  IMPERSONATION_COOKIE,
  SESSION_COOKIE,
  config,
  requireAuthSecret,
} from "@/lib/config";
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
  /**
   * Set only while a platform administrator is signed in as this user.
   *
   * The session is genuinely the owner's - that is the point, it has to see
   * exactly what they see - so the only thing separating support from a
   * silent takeover is that the token says so. Every screen that renders it
   * and every record written under it can therefore be traced back to the
   * person who started it.
   */
  impersonatorId?: string;
  impersonatorName?: string;
  /**
   * Signed in with a temporary password that has not been replaced yet.
   * Middleware allows nothing but /change-password while this is set.
   */
  mustChangePassword?: boolean;
}

const encoder = new TextEncoder();

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function secretKey(): Uint8Array {
  return encoder.encode(requireAuthSecret());
}

export async function signSession(
  user: SessionUser,
  ttlSeconds = config.sessionTtlSeconds,
): Promise<string> {
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
    // Absent on an ordinary sign-in, so a normal token is byte-for-byte what
    // it always was and nothing downstream has to know this feature exists.
    ...(user.impersonatorId
      ? { impBy: user.impersonatorId, impName: user.impersonatorName ?? "" }
      : {}),
    ...(user.mustChangePassword ? { mcp: true } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
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
      ...(str(payload.impBy)
        ? {
            impersonatorId: str(payload.impBy),
            impersonatorName: str(payload.impName),
          }
        : {}),
      ...(payload.mcp === true ? { mustChangePassword: true } : {}),
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

/**
 * Cookie options for the parked platform session.
 *
 * Same flags as the live one, with one difference that matters: it is not
 * readable on the pharmacy side by anything but this application, and it
 * expires on its own, so an abandoned impersonation cannot leave a superadmin
 * token sitting in a browser indefinitely.
 */
export function impersonationCookieOptions(maxAge: number) {
  return {
    ...sessionCookieOptions(maxAge),
    name: IMPERSONATION_COOKIE,
  };
}

export { IMPERSONATION_COOKIE, SESSION_COOKIE };
