import { ok, parseJson, withRoute } from "@/lib/api";
import { completePasswordReset } from "@/lib/password-reset";
import { resetPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset-password - spend a link and set the new password.
 *
 * Unauthenticated, because the whole point is that the person cannot sign in.
 * The token is the credential: it is random, single use, short lived and
 * stored only as a hash. See lib/password-reset.ts.
 *
 * No session is issued on success. Making someone sign in with the password
 * they just chose is the cheap way to be sure it is the one they meant, and
 * it means a reset link alone never becomes a signed-in browser.
 */
export const POST = withRoute(async (req) => {
  const { token, password } = await parseJson(req, resetPasswordSchema);
  const { email } = await completePasswordReset(token, password);

  return ok({
    email,
    message: "Your password has been changed. Sign in with it now.",
  });
});
