import { ok, parseJson, withRoute } from "@/lib/api";
import { requestPasswordReset } from "@/lib/password-reset";
import { forgotPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot-password - email a reset link.
 *
 * Always answers the same way, whether or not the address belongs to an
 * account. This endpoint is unauthenticated and public: a reply that
 * distinguished the two would turn it into a way to test whether a given
 * pharmacy owner is on the platform, one address at a time.
 *
 * That also means a mail failure cannot be reported. It is logged by the
 * transport; the caller is told what it would have been told anyway.
 */
export const POST = withRoute(async (req) => {
  const { email } = await parseJson(req, forgotPasswordSchema);

  // Best effort, for reading an abuse pattern out of the logs later. Behind a
  // proxy this is whatever the proxy chose to forward.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "";

  await requestPasswordReset(email, ip);

  return ok({
    message:
      "If that address has an account, a reset link is on its way. It expires in an hour.",
  });
});
