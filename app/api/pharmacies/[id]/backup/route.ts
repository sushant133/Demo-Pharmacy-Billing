import { withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { backupPharmacy } from "@/lib/pharmacy-backup";
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
  await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const { filename, body } = await backupPharmacy(objectIdSchema.parse(id));

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
});
