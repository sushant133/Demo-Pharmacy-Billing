import { ApiError, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveRequestScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { PrescriptionImage, imageBytes } from "@/models/PrescriptionImage";
import { Sale } from "@/models/Sale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sales/:id/prescription-image
 *
 * Patient data, so it is held to the same tenant and branch checks as the bill
 * it belongs to, and is never cached by anything in between.
 */
export const GET = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("sale:read");
  const { id } = await ctx.params;
  if (!objectIdSchema.safeParse(id).success) throw ApiError.notFound("That bill no longer exists.");
  await connectDB();

  const sale = await Sale.findOne({ _id: id, ...pharmacyFilter(user) }).select("branchId").lean();
  if (!sale) throw ApiError.notFound("That bill no longer exists.");
  assertVisibleInScope(sale.branchId, await resolveRequestScope(user, req));

  const image = await PrescriptionImage.findOne({ saleId: sale._id, ...pharmacyFilter(user) }).lean();
  if (!image) throw ApiError.notFound("No prescription photo was kept for this bill.");

  return new Response(new Uint8Array(imageBytes(image.data)), {
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
