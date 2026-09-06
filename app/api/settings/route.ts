import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getSettings, saveSettings, vatPercent } from "@/lib/settings";
import { settingsSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shop's own details: name, PAN, VAT registration, licences, contact and
 * the lines it prints on a bill.
 *
 * One record, so there is no collection to list and no id to address - GET
 * reads it and PUT replaces it.
 */

/** GET /api/settings - the current details, VAT rate as a percentage. */
export const GET = withRoute(async () => {
  const user = await requirePermission("settings:manage");
  const settings = await getSettings(user.pharmacyId, user.pharmacyName);
  return ok({ ...settings, vatRate: vatPercent(settings) });
});

/** PUT /api/settings - replace them. Creates the record on the first save. */
export const PUT = withRoute(async (req) => {
  const user = await requirePermission("settings:manage");
  const input = await parseJson(req, settingsSchema);
  if (!user.pharmacyId) {
    throw ApiError.forbidden("Settings belong to a pharmacy account.");
  }
  const settings = await saveSettings(input, user.pharmacyId);
  return ok({ ...settings, vatRate: vatPercent(settings) });
});
