import { cookies } from "next/headers";
import { created, parseJson, withRoute, ApiError } from "@/lib/api";
import { verifyPassword } from "@/lib/auth";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { signSession, sessionCookieOptions } from "@/lib/session";
import { loginSchema } from "@/lib/validation";
import { User } from "@/models/User";
import { Branch } from "@/models/Branch";
import { Pharmacy } from "@/models/Pharmacy";
import { normalizeRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/login - exchange credentials for a session cookie. */
export const POST = withRoute(async (req) => {
  const { email, password } = await parseJson(req, loginSchema);
  await connectDB();

  // passwordHash is `select: false`, so ask for it explicitly.
  const user = await User.findOne({ email }).select("+passwordHash").lean();

  // Same message and roughly the same work for both failure modes, so the
  // response cannot be used to enumerate which emails exist.
  const invalid = ApiError.unauthorized("Email or password is incorrect.");

  if (!user) {
    await verifyPassword(password, "$2a$12$" + "x".repeat(53));
    throw invalid;
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw invalid;
  if (user.isActive === false) {
    throw ApiError.forbidden("This account has been deactivated.");
  }
  // A row written before narrower roles existed carries no `roleVersion`, so
  // a stored "pharmacist" or "cashier" still signs in as the owner it used to
  // mean. `npm run migrate:roles` resolves those rows to an explicit role.
  const role = normalizeRole(user.role, user.roleVersion);
  if (!role) {
    throw ApiError.forbidden("This account has an unrecognised role.");
  }

  let pharmacyId = "";
  let pharmacyName = "";
  let pharmacySlug = "";

  if (role !== "superadmin") {
    if (!user.pharmacyId) {
      throw ApiError.forbidden(
        "This account is not attached to a pharmacy. Ask the platform administrator to issue a new login.",
      );
    }
    const pharmacy = await Pharmacy.findById(user.pharmacyId)
      .select("name slug status")
      .lean();
    if (!pharmacy) {
      throw ApiError.forbidden(
        "This pharmacy no longer exists. Ask the platform administrator for a new account.",
      );
    }
    if (pharmacy.status === "suspended") {
      throw ApiError.forbidden(
        "This pharmacy has been suspended. Contact the platform administrator.",
      );
    }
    pharmacyId = String(pharmacy._id);
    pharmacyName = pharmacy.name;
    pharmacySlug = pharmacy.slug;
  }

  // The branch travels in the token so middleware and every server component
  // can scope a query without a lookup. A user whose branch was closed can
  // still sign in and see their history; the write paths are what refuse.
  const branch = user.branchId
    ? await Branch.findById(user.branchId).select("code name").lean()
    : null;

  const sessionUser = {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role,
    pharmacyId,
    pharmacyName,
    pharmacySlug,
    branchId: branch ? String(branch._id) : "",
    branchCode: branch?.code ?? "",
    branchName: branch?.name ?? "",
  };

  const token = await signSession(sessionUser);
  const cookieStore = await cookies();
  cookieStore.set({
    ...sessionCookieOptions(config.sessionTtlSeconds),
    value: token,
  });

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  return created({ user: sessionUser });
});

/** GET is not meaningful here, but a clear 405-style error beats a stack trace. */
export const GET = withRoute(async () => {
  throw ApiError.badRequest("Use POST to sign in.");
});
