import { ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { postPurchase } from "@/lib/purchases";
import { objectIdSchema, purchasePostSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/purchases/:id/post
 *
 * The moment stock becomes real: creates a Batch per line (or tops up an
 * existing lot of the same batch number), inside one transaction.
 *
 * An optional body records what was paid at the door, written in the same
 * transaction as the stock. The body is genuinely optional - posting with no
 * payload at all still works, which is what the detail screen's Post button
 * sends - so this parses the request defensively rather than requiring JSON.
 */
export const POST = withRoute<Ctx>(async (req, ctx) => {
  const user = await requirePermission("purchase:post");
  const { id } = await ctx.params;

  const raw = await req.json().catch(() => ({}));
  const parsed = purchasePostSchema.safeParse(raw ?? {});
  const payment = parsed.success ? parsed.data.payment : undefined;

  const result = await postPurchase(objectIdSchema.parse(id), user, payment);
  return ok(result);
});
