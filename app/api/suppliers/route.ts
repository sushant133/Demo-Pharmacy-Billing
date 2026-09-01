import { created, ok, parseJson, parseQuery, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB, withDbWrite } from "@/lib/db";
import { round2 } from "@/lib/purchase-math";
import { getBalancesFor } from "@/lib/suppliers";
import { Supplier } from "@/models/Supplier";
import { supplierQuerySchema, supplierSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/suppliers
 * Query: q, status=all|active|inactive|owing, page, pageSize
 *
 * Every row carries its derived outstanding balance, because a supplier list
 * without "what do I owe them" is not much use to whoever is paying the bills.
 */
export const GET = withRoute(async (req) => {
  await requirePermission("supplier:read");
  const { q, status, page, pageSize } = parseQuery(req, supplierQuerySchema);
  await connectDB();

  const filter: Record<string, unknown> = {};
  if (status === "active") filter.isActive = { $ne: false };
  if (status === "inactive") filter.isActive = false;

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { name: pattern },
      { contactPerson: pattern },
      { phone: pattern },
      { panNo: pattern },
    ];
  }

  const [docs, total] = await Promise.all([
    Supplier.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Supplier.countDocuments(filter),
  ]);

  const balances = await getBalancesFor(docs.map((doc) => doc._id));

  let rows = docs.map((doc) => {
    const balance = balances.get(String(doc._id)) ?? { purchased: 0, paid: 0 };
    const outstanding = round2(
      (doc.openingBalance ?? 0) + balance.purchased - balance.paid,
    );

    return {
      id: String(doc._id),
      name: doc.name,
      contactPerson: doc.contactPerson ?? "",
      phone: doc.phone ?? "",
      email: doc.email ?? "",
      address: doc.address ?? "",
      panNo: doc.panNo ?? "",
      paymentTermsDays: doc.paymentTermsDays ?? 0,
      openingBalance: doc.openingBalance ?? 0,
      notes: doc.notes ?? "",
      isActive: doc.isActive !== false,
      purchased: balance.purchased,
      paid: balance.paid,
      outstanding,
      createdAt: doc.createdAt,
    };
  });

  // "owing" is a property of the derived balance, so it filters after the fact
  // rather than in the query.
  if (status === "owing") rows = rows.filter((row) => row.outstanding > 0);

  return ok(rows, {
    page,
    pageSize,
    total: status === "owing" ? rows.length : total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/** POST /api/suppliers */
export const POST = withRoute(async (req) => {
  await requirePermission("supplier:write");
  const input = await parseJson(req, supplierSchema);

  const supplier = await withDbWrite(() => Supplier.create(input));
  return created({
    id: String(supplier._id),
    name: supplier.name,
    contactPerson: supplier.contactPerson ?? "",
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    address: supplier.address ?? "",
    panNo: supplier.panNo ?? "",
    paymentTermsDays: supplier.paymentTermsDays ?? 0,
    openingBalance: supplier.openingBalance ?? 0,
    notes: supplier.notes ?? "",
    isActive: supplier.isActive !== false,
  });
});
