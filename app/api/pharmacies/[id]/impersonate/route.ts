import { cookies } from "next/headers";
import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import {
  IMPERSONATION_TTL_SECONDS,
  config,
} from "@/lib/config";
import { connectDB } from "@/lib/db";
import { recordPlatformEvent } from "@/lib/platform-events";
import { normalizeRole } from "@/lib/roles";
import {
  SESSION_COOKIE,
  impersonationCookieOptions,
  sessionCookieOptions,
  signSession,
} from "@/lib/session";
import { objectIdSchema } from "@/lib/validation";
import { Branch } from "@/models/Branch";
import { Pharmacy } from "@/models/Pharmacy";
import { User } from "@/models/User";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/pharmacies/:id/impersonate - sign in as this shop's owner.
 *
 * Support needs to see what the owner sees. A description over the phone is
 * not the same screen, and asking for their password is worse than this: it
 * hands over an credential that outlives the call and leaves no record.
 *
 * So the session issued here is genuinely the owner's - same role, same
 * pharmacy, same branch - with three things that a real sign-in does not
 * have:
 *
 *   - it carries who started it, which the shop's own chrome displays in a
 *     banner the whole time, so nobody is being watched without being told;
 *   - it expires in half an hour rather than a shift;
 *   - it is written to the platform's audit trail before the cookie is set.
 *
 * The superadmin's own session is parked, unmodified, in a second cookie so
 * returning to the platform is a click rather than a fresh sign-in. It is the
 * same signed token with the same `exp`, so an impersonation cannot be used
 * to extend a platform session past its normal life: if it lapses while they
 * are inside the shop, there is nothing to go back to and they sign in again.
 */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);

  await connectDB();
  const pharmacy = await Pharmacy.findById(pharmacyId)
    .select("name slug status ownerUserId")
    .lean();
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  // A suspended shop's owner cannot sign in, and neither should anyone
  // standing in for them: the whole point of a suspension is that the
  // account is out of service.
  if (pharmacy.status === "suspended") {
    throw ApiError.conflict(
      `${pharmacy.name} is suspended. Activate it before signing in as its owner.`,
    );
  }
  if (!pharmacy.ownerUserId) {
    throw ApiError.conflict(`${pharmacy.name} has no owner account to sign in as.`);
  }

  const owner = await User.findById(pharmacy.ownerUserId).lean();
  if (!owner) {
    throw ApiError.conflict(`${pharmacy.name}'s owner account is missing.`);
  }
  if (owner.isActive === false) {
    throw ApiError.conflict("That owner account is deactivated.");
  }

  const role = normalizeRole(owner.role, owner.roleVersion);
  if (!role || role === "superadmin") {
    throw ApiError.conflict("That account cannot be impersonated.");
  }

  const branch = owner.branchId
    ? await Branch.findById(owner.branchId).select("code name").lean()
    : null;

  const impersonated = {
    id: String(owner._id),
    name: owner.name,
    email: owner.email,
    role,
    pharmacyId: String(pharmacy._id),
    pharmacyName: pharmacy.name,
    pharmacySlug: pharmacy.slug,
    branchId: branch ? String(branch._id) : "",
    branchCode: branch?.code ?? "",
    branchName: branch?.name ?? "",
    impersonatorId: actor.id,
    impersonatorName: actor.name,
  };

  await recordPlatformEvent(actor, "impersonation.started", {
    pharmacyId: String(pharmacy._id),
    pharmacyName: pharmacy.name,
    summary: `Signed in as ${owner.name} at ${pharmacy.name}.`,
    detail: `Session expires in ${Math.round(IMPERSONATION_TTL_SECONDS / 60)} minutes.`,
  });

  const cookieStore = await cookies();
  const platformToken = cookieStore.get(SESSION_COOKIE)?.value;

  if (platformToken) {
    cookieStore.set({
      ...impersonationCookieOptions(config.sessionTtlSeconds),
      value: platformToken,
    });
  }

  cookieStore.set({
    ...sessionCookieOptions(IMPERSONATION_TTL_SECONDS),
    value: await signSession(impersonated, IMPERSONATION_TTL_SECONDS),
  });

  return ok({ pharmacy: pharmacy.name, signedInAs: owner.name });
});
