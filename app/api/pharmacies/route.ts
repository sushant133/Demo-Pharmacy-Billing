import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
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

/** POST /api/pharmacies - create a pharmacy and its owner login. */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("pharmacy:manage");
  const input = await parseJson(req, createPharmacySchema);
  const pharmacy = await createPharmacy(input, user);

  await recordPlatformEvent(user, "pharmacy.created", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Created ${pharmacy.name} with owner ${pharmacy.ownerEmail}.`,
    detail: `Short code ${pharmacy.slug}.`,
  });

  return created(pharmacy);
});
