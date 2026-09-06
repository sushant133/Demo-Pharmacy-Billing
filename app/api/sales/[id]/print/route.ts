import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { Sale } from "@/models/Sale";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/:id/print
 *
 * First print stamps `printedAt` (the original). Later prints increment
 * `reprintCount` so the paper can say "Copy of Original – N", which IRD
 * requires of reprints.
 */
export const POST = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("sale:read");
  const { id } = await ctx.params;
  await connectDB();

  const query = objectIdSchema.safeParse(id).success
    ? { _id: id, ...pharmacyFilter(user) }
    : { billNo: decodeURIComponent(id).toUpperCase(), ...pharmacyFilter(user) };

  const sale = await Sale.findOne(query).select("printedAt reprintCount").lean();
  if (!sale) throw ApiError.notFound("That bill no longer exists.");

  if (!sale.printedAt) {
    await Sale.updateOne(
      { _id: sale._id, printedAt: null },
      { $set: { printedAt: new Date() } },
    );
    return ok({ original: true, reprintCount: 0, label: "ORIGINAL" });
  }

  const updated = await Sale.findByIdAndUpdate(
    sale._id,
    { $inc: { reprintCount: 1 } },
    { new: true, select: "reprintCount" },
  ).lean();

  const reprintCount = updated?.reprintCount ?? (sale.reprintCount ?? 0) + 1;
  return ok({
    original: false,
    reprintCount,
    label: `Copy of Original – ${reprintCount}`,
  });
});
