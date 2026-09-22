import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { generateTemporaryPassword, requirePermission } from "@/lib/auth";
import { sendPharmacyWelcomeEmail } from "@/lib/email/messages";
import { createPharmacy, listPharmacies, pharmacyCounts } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { createPharmacySchema, pharmacyQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/pharmacies - every tenant the platform has issued. */
export const GET = withRoute(async (req) => {
  await requirePermission("pharmacy:manage");
  const { q, status, page, pageSize } = parseQuery(req, pharmacyQuerySchema);
  const [{ rows, total }, counts] = await Promise.all([
    listPharmacies({ q, status, page, pageSize }),
    pharmacyCounts(),
  ]);

  return ok(rows, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    counts,
  });
});

/**
 * POST /api/pharmacies - create a pharmacy and its owner login.
 *
 * The owner's password is generated here, never typed by superadmin, and
 * emailed to the owner's address. They are made to replace it on first
 * sign-in (`mustChangePassword`).
 *
 * The send happens after the account is durable and cannot undo it: a relay
 * that is down must not cost somebody a half-created pharmacy. In that one
 * case the temporary password comes back in the response, so the screen can
 * show it to be passed on by hand. When the mail went out it is left out -
 * the fewer places it appears, the better.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("pharmacy:manage");
  const input = await parseJson(req, createPharmacySchema);
  const temporaryPassword = generateTemporaryPassword();
  const pharmacy = await createPharmacy(input, user, temporaryPassword);

  const delivery = await sendPharmacyWelcomeEmail({
    to: pharmacy.ownerEmail,
    ownerName: pharmacy.ownerName,
    pharmacyName: pharmacy.name,
    email: pharmacy.ownerEmail,
    password: temporaryPassword,
  });

  await recordPlatformEvent(user, "pharmacy.created", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Created ${pharmacy.name} with owner ${pharmacy.ownerEmail}.`,
    detail: [
      `Short code ${pharmacy.slug}.`,
      delivery.sent
        ? `Credentials emailed to ${pharmacy.ownerEmail}.`
        : delivery.logged
          ? "Credentials not emailed: no mail relay is configured."
          : `Credentials could not be emailed: ${delivery.error}`,
    ].join(" "),
  });

  return created({
    ...pharmacy,
    credentialsEmailed: delivery.sent,
    ...(delivery.sent ? {} : { temporaryPassword }),
  });
});
