import { randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { ApiError } from "@/lib/api";
import { SESSION_COOKIE, verifySession, type SessionUser } from "@/lib/session";
import { can, type Permission, type Role } from "@/lib/roles";

/**
 * Server-side auth helpers.
 *
 * Node runtime only (bcrypt + next/headers). Middleware uses lib/session.ts
 * directly instead of importing this file.
 */

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/*
  No 0/O, 1/l/I: this gets read off an email and typed on a phone, sometimes
  read aloud. Losing six look-alikes still leaves 56 symbols; twelve of them
  is ~70 bits, which is plenty for something that must be replaced on first
  use.
*/
const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * A one-time password for a login the platform creates on somebody's behalf.
 *
 * Grouped as xxxx-xxxx-xxxx so it is easy to copy by eye. `randomInt` rather
 * than `Math.random`: this is a credential. The holder is made to replace it
 * on first sign-in - see `mustChangePassword` on the User model.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g += 1) {
    let group = "";
    for (let i = 0; i < 4; i += 1) {
      group += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** The signed-in user, or null. Safe to call from any server component. */
export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

// ---------------------------------------------------------------------------
// API route guards - these throw ApiError, which withRoute turns into JSON.
// ---------------------------------------------------------------------------

/** Require a signed-in user in an API route. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw ApiError.unauthorized();
  return session;
}

/**
 * Require a signed-in user holding a specific permission.
 *
 * Usage inside a route handler:
 *   const user = await requirePermission("medicine:delete");
 */
export async function requirePermission(
  permission: Permission,
): Promise<SessionUser> {
  const session = await requireSession();
  if (!can(session.role, permission)) {
    throw ApiError.forbidden(
      `Your role (${session.role}) is not allowed to perform this action.`,
    );
  }
  return session;
}

/** Require one of an explicit set of roles. */
export async function requireRole(
  ...roles: readonly Role[]
): Promise<SessionUser> {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw ApiError.forbidden(
      `This action is restricted to: ${roles.join(", ")}.`,
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// Page guards - these redirect rather than throw.
// ---------------------------------------------------------------------------

/** Require a session in a server component; bounce to /login otherwise. */
export async function requirePageSession(
  returnTo?: string,
): Promise<SessionUser> {
  const session = await getSession();
  if (!session) {
    const target = returnTo
      ? `/login?next=${encodeURIComponent(returnTo)}`
      : "/login";
    redirect(target);
  }
  return session;
}

/** Require a permission in a server component; bounce to the dashboard. */
export async function requirePagePermission(
  permission: Permission,
): Promise<SessionUser> {
  const session = await requirePageSession();
  if (!can(session.role, permission)) redirect("/dashboard?denied=1");
  return session;
}
