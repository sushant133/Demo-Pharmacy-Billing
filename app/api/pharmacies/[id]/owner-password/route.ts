import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { sendOwnerCredentialsEmail } from "@/lib/email/messages";
import { getPharmacy, resetOwnerPassword } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema, resetOwnerPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/pharmacies/:id/owner-password - set a new owner password.
 *
 * The new password is emailed to the owner. This is the recovery path when
 * the welcome mail never arrived: the original is bcrypt-hashed and cannot be
 * read back, so it cannot be re-sent - a new one has to be issued. It is also
 * what a shop gets when they phone up locked out.
 *
 * Sending cannot undo the reset. The password is already changed and is on
 * the screen in front of whoever typed it, so a dead relay means "read it out
 * over the phone", not "the account is now in an unknown state". The response
 * says which happened so the screen can too.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);
  const { password } = await parseJson(req, resetOwnerPasswordSchema);

  await resetOwnerPassword(pharmacyId, password);
  const pharmacy = await getPharmacy(pharmacyId);

  const delivery = await sendOwnerCredentialsEmail({
    to: pharmacy.ownerEmail,
    ownerName: pharmacy.ownerName,
    pharmacyName: pharmacy.name,
    email: pharmacy.ownerEmail,
    password,
  });

  // The password itself is never recorded - only that it was changed, by
  // whom, for which login, and whether it reached them.
  await recordPlatformEvent(actor, "owner.password-reset", {
    pharmacyId,
    pharmacyName: pharmacy.name,
    summary: `Reset the owner password for ${pharmacy.ownerEmail}.`,
    detail: delivery.sent
      ? `New credentials emailed to ${pharmacy.ownerEmail}.`
      : delivery.logged
        ? "Not emailed: no mail transport is configured. Pass the password on by hand."
        : `Could not be emailed: ${delivery.error}`,
  });

  return ok({ reset: true, credentialsEmailed: delivery.sent });
});
