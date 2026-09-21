import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { deletePharmacy, getPharmacy, updatePharmacy } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { invalidateSettings } from "@/lib/settings";
import {
  deletePharmacySchema,
  objectIdSchema,
  updatePharmacySchema,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function pharmacyId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  return objectIdSchema.parse(id);
}

/** GET /api/pharmacies/:id */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  return ok(await getPharmacy(id));
});

/**
 * PATCH /api/pharmacies/:id - the platform's record of this shop.
 *
 * Name, registration, licence, PAN, VAT number, contact details and the
 * owner's KYC. Status has its own routes, and so does the owner login and the
 * bill template: those are actions somebody decides to take, not fields
 * edited in passing.
 *
 * The identity fields here are the shop's printed bill header, which it can
 * read but not change, so the cached copy has to go with the write.
 */
export const PATCH = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  const input = await parseJson(req, updatePharmacySchema);
  const pharmacy = await updatePharmacy(id, input);
  invalidateSettings(id);

  await recordPlatformEvent(actor, "pharmacy.updated", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Updated the record for ${pharmacy.name}.`,
  });

  return ok(pharmacy);
});

/**
 * DELETE /api/pharmacies/:id - remove a shop and everything it owns.
 *
 * Guarded in the service: the pharmacy must already be suspended, and the
 * body must carry its short code typed by hand. The event is written after
 * the deletion rather than before, because a row describing a deletion that
 * did not happen is worse than no row - and the platform's audit trail lives
 * outside the tenant, so it survives the shop it describes.
 */
export const DELETE = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const id = await pharmacyId(ctx);
  const { confirm } = await parseJson(req, deletePharmacySchema);

  const result = await deletePharmacy(id, confirm);
  const counts = Object.entries(result.deleted)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");

  await recordPlatformEvent(actor, "pharmacy.deleted", {
    pharmacyId: id,
    pharmacyName: result.name,
    summary: `Deleted ${result.name} (${result.slug}) and every record it owned.`,
    detail: counts || "Nothing was stored against it.",
  });

  return ok(result);
});
