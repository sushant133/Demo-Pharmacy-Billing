import { created, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { Customer } from "@/models/Customer";
import { outstandingByCustomer } from "@/lib/customer-dues";
import { pharmacyFilter } from "@/lib/tenant";
import { customerSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/customers?q= - lookup for the billing screen's customer field. */
export const GET = withRoute(async (req) => {
  const user = await requirePermission("customer:read");
  await connectDB();

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  const filter: Record<string, unknown> = { ...pharmacyFilter(user) };

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [{ name: pattern }, { phone: pattern }];
  }

  const docs = await Customer.find(filter).sort({ name: 1 }).limit(20).lean();

  // What each one already owes, so the till can say so before the counter
  // extends more credit to somebody who is behind on three bills.
  const dues = await outstandingByCustomer(
    user,
    docs.map((doc) => String(doc._id)),
  );

  return ok(
    docs.map((doc) => ({
      id: String(doc._id),
      name: doc.name,
      phone: doc.phone ?? "",
      address: doc.address ?? "",
      panNo: doc.panNo ?? "",
      outstanding: dues.get(String(doc._id)) ?? 0,
    })),
  );
});

/** POST /api/customers - save a walk-in as a returning customer. */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("customer:write");
  const input = await parseJson(req, customerSchema);
  await connectDB();

  const customer = await Customer.create({ ...input, ...pharmacyFilter(user) });
  return created({ id: String(customer._id), ...customer.toJSON() });
});
