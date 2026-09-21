import { withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { getPharmacy } from "@/lib/pharmacies";
import { backupPharmacy } from "@/lib/pharmacy-backup";
import { recordPlatformEvent } from "@/lib/platform-events";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/pharmacies/:id/backup
 *
 * JSON dump of that pharmacy only: catalogue, lots, bills, GRNs, suppliers,
 * customers, staff (without password hashes), settings and number sequences.
 */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);
  const [{ filename, body }, pharmacy] = await Promise.all([
    backupPharmacy(pharmacyId),
    getPharmacy(pharmacyId),
  ]);

  // A copy of a shop's entire history has just left the server. That is worth
  // a line in an audit trail whoever downloaded it cannot edit.
  await recordPlatformEvent(actor, "backup.downloaded", {
    pharmacyId,
    pharmacyName: pharmacy.name,
    summary: `Downloaded a full backup of ${pharmacy.name} (${filename}).`,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
});
