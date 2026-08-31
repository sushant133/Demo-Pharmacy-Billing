import { created, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { Customer } from "@/models/Customer";
import { customerSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/customers?q= - lookup for the billing screen's customer field. */
export const GET = withRoute(async (req) => {
  await requirePermission("customer:read");
  await connectDB();

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  const filter: Record<string, unknown> = {};

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [{ name: pattern }, { phone: pattern }];
  }

  const docs = await Customer.find(filter).sort({ name: 1 }).limit(20).lean();

  return ok(
    docs.map((doc) => ({
      id: String(doc._id),
      name: doc.name,
      phone: doc.phone ?? "",
      address: doc.address ?? "",
      panNo: doc.panNo ?? "",
    })),
  );
});

/** POST /api/customers - save a walk-in as a returning customer. */
export const POST = withRoute(async (req) => {
  await requirePermission("customer:write");
  const input = await parseJson(req, customerSchema);
  await connectDB();

  const customer = await Customer.create(input);
  return created({ id: String(customer._id), ...customer.toJSON() });
});
