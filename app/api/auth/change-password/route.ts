import { cookies } from "next/headers";
import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { hashPassword, requireSession, verifyPassword } from "@/lib/auth";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { homePath } from "@/lib/roles";
import { sessionCookieOptions, signSession } from "@/lib/session";
import { changePasswordSchema } from "@/lib/validation";
import { User } from "@/models/User";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/change-password - replace your own password.
 *
 * This is the endpoint behind the forced first-login change: an owner signed
 * in on the temporary password from their welcome email is held on
 * /change-password by middleware until this succeeds.
 *
 * On success the session is re-signed without the flag, so the very next
 * request goes through. Re-issuing rather than asking them to sign in again:
 * they have just proved both the old password and the new one.
 */
export const POST = withRoute(async (req) => {
  const session = await requireSession();
  if (session.impersonatorId) {
    throw ApiError.forbidden(
      "You are signed in as this owner for support. Only the owner can change their password.",
    );
  }

  const { currentPassword, password } = await parseJson(req, changePasswordSchema);
  await connectDB();

  const user = await User.findById(session.id).select("+passwordHash");
  if (!user || user.isActive === false) {
    throw ApiError.unauthorized("This account is no longer active.");
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest("Your current password is incorrect.");
  }

  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  await user.save();

  const { mustChangePassword: _cleared, ...rest } = session;
  const cookieStore = await cookies();
  cookieStore.set({
    ...sessionCookieOptions(config.sessionTtlSeconds),
    value: await signSession(rest),
  });

  return ok({ changed: true, next: homePath(session.role) });
});
