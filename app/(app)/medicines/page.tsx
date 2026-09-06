import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { pharmacyFilter } from "@/lib/tenant";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { formatExpiry, integer } from "@/lib/format";
import { can } from "@/lib/roles";
import { mergeMedicineCategories } from "@/lib/constants";
import { getLowStock } from "@/lib/reports";
import { getSettings } from "@/lib/settings";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Badge, Card, EmptyState, PageHeader, Pagination, TableWrap } from "@/components/ui";
import { MedicineFormPanel } from "@/components/medicines/MedicineFormPanel";

export const metadata: Metadata = { title: "Medicines" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Medicine catalogue.
 *
 * Server component: the list, filters and stock roll-up all render on the
 * server. Only the add/edit panel is a client island, opened by ?new=1 or
 * ?edit=<id> so the form is linkable and survives a refresh.
 */
export default async function MedicinesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    view?: string;
    page?: string;
    new?: string;
    edit?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("medicine:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const lowStockView = params.view === "low-stock";
  const editable = can(user.role, "medicine:write");

  if (lowStockView) {
    const { rows, total } = await withDbRead(async () => {
      const scope = await resolveViewScope(user, params.branch);
      return getLowStock({ page, pageSize: PAGE_SIZE, scope });
    });

    return (
      <>
        <PageHeader
          title="Low stock"
          subtitle={`Medicines with fewer than ${config.lowStockThreshold} sellable units. Expired batches are not counted.`}
          actions={
            <Link href="/medicines" className="btn-secondary">
              All medicines
            </Link>
          }
        />

        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState
              title="Everything is well stocked"
              description="No medicine has fallen below its reorder level."
            />
          ) : (
            <>
              <TableWrap>
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="th">Medicine</th>
                    <th className="th">Category</th>
                    <th className="th text-right">In stock</th>
                    <th className="th text-right">Reorder at</th>
                    <th className="th text-right">Batches</th>
                    <th className="th">Nearest expiry</th>
                    {can(user.role, "purchase:write") ? (
                      <th className="th"></th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.medicineId} className="hover:bg-slate-50">
                      <td className="td">
                        <p className="font-medium text-slate-900">{row.name}</p>
                        {row.genericName ? (
                          <p className="text-xs text-slate-500">{row.genericName}</p>
                        ) : null}
                      </td>
                      <td className="td text-slate-600">{row.category}</td>
                      <td className="td tnum text-right">
                        <span
                          className={
                            row.totalQuantity === 0
                              ? "font-semibold text-rose-600"
                              : "font-semibold text-amber-600"
                          }
                        >
                          {integer(row.totalQuantity)}
                        </span>
                        <span className="ml-1 text-xs text-slate-400 capitalize">
                          {row.unit}
                        </span>
                      </td>
                      <td className="td tnum text-right text-slate-500">
                        {integer(row.threshold)}
                      </td>
                      <td className="td tnum text-right text-slate-500">
                        {row.batchCount}
                      </td>
                      <td className="td text-slate-600">
                        {row.nearestExpiry ? formatExpiry(row.nearestExpiry) : "—"}
                      </td>
                      {can(user.role, "purchase:write") ? (
                        <td className="td text-right">
                          <Link
                            href={`/purchases/new?medicineId=${row.medicineId}`}
                            className="text-xs font-medium text-brand-700 hover:underline"
                          >
                            Add stock
                          </Link>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </TableWrap>

              <Pagination
                page={page}
                totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
                total={total}
                baseHref="/medicines?view=low-stock"
              />
            </>
          )}
        </Card>
      </>
    );
  }

  // ---- Full catalogue ------------------------------------------------------
  const { medicines, total, stock, settings, categories } = await withDbRead(
    async () => {
    const scope = await resolveViewScope(user, params.branch);

    const filter: Record<string, unknown> = { ...pharmacyFilter(user) };
    if (params.category) filter.category = params.category;
    if (params.q?.trim()) {
      const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(safe, "i");
      filter.$or = [
        { name: pattern },
        { genericName: pattern },
        { saltComposition: pattern },
        { manufacturer: pattern },
      ];
    }

    const [medicines, total, settings, usedCategories] = await Promise.all([
      Medicine.find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Medicine.countDocuments(filter),
      getSettings(user.pharmacyId, user.pharmacyName),
      Medicine.distinct("category", pharmacyFilter(user)),
    ]);
    const categories = mergeMedicineCategories([
      ...settings.medicineCategories,
      ...usedCategories.filter((name): name is string => typeof name === "string"),
    ]);

    // One aggregate for the whole page's stock, rather than a query per row.
    const now = new Date();
    const stockRows = await Batch.aggregate<{
      _id: unknown;
      quantity: number;
      nearestExpiry: Date | null;
    }>([
      {
        $match: {
          medicineId: { $in: medicines.map((medicine) => medicine._id) },
          quantity: { $gt: 0 },
          expiryDate: { $gte: now },
          ...branchFilter(scope),
        },
      },
      {
        $group: {
          _id: "$medicineId",
          quantity: { $sum: "$quantity" },
          nearestExpiry: { $min: "$expiryDate" },
        },
      },
    ]);

    return {
      medicines,
      total,
      settings,
      categories,
      stock: new Map(
        stockRows.map((row) => [
          String(row._id),
          { quantity: row.quantity, nearestExpiry: row.nearestExpiry },
        ]),
      ),
    };
  });

  const editing = params.edit
    ? medicines.find((medicine) => String(medicine._id) === params.edit)
    : undefined;

  const baseQuery = new URLSearchParams();
  if (params.q) baseQuery.set("q", params.q);
  if (params.category) baseQuery.set("category", params.category);

  return (
    <>
      <PageHeader
        title="Medicines"
        subtitle={`${integer(total)} item${total === 1 ? "" : "s"} in the catalogue`}
        actions={
          <>
            <Link href="/medicines?view=low-stock" className="btn-secondary">
              Low stock
            </Link>
            {editable ? (
              <Link href="/medicines?new=1" className="btn-primary">
                Add medicine
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-4 p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Brand, generic, salt or manufacturer"
              className="input"
            />
          </div>
          <div>
            <label htmlFor="category" className="label">
              Category
            </label>
            <select
              id="category"
              name="category"
              defaultValue={params.category ?? ""}
              className="input"
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Filter
            </button>
            <Link href="/medicines" className="btn-secondary">
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {medicines.length === 0 ? (
          <EmptyState
            title="No medicines found"
            description={
              params.q || params.category
                ? "Nothing matches those filters."
                : "Add your first medicine, or run the seed script to load sample data."
            }
            action={
              editable ? (
                <Link href="/medicines?new=1" className="btn-primary">
                  Add medicine
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Medicine</th>
                  <th className="th">Manufacturer</th>
                  <th className="th">Category</th>
                  <th className="th">Unit</th>
                  <th className="th text-right">In stock</th>
                  <th className="th">Nearest expiry</th>
                  {editable ? <th className="th"></th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {medicines.map((medicine) => {
                  const rowStock = stock.get(String(medicine._id));
                  const quantity = rowStock?.quantity ?? 0;
                  const threshold = medicine.reorderLevel ?? config.lowStockThreshold;

                  return (
                    <tr key={String(medicine._id)} className="hover:bg-slate-50">
                      <td className="td">
                        <p className="font-medium text-slate-900">
                          {medicine.name}
                          {medicine.packSize ? (
                            <span className="ml-1.5 text-xs font-normal text-slate-400">
                              {medicine.packSize}
                            </span>
                          ) : null}
                          {medicine.isActive === false ? (
                            <Badge tone="slate" className="ml-2">
                              Inactive
                            </Badge>
                          ) : null}
                          {medicine.requiresPrescription ? (
                            <Badge tone="amber" className="ml-2">
                              Rx
                            </Badge>
                          ) : null}
                        </p>
                        {medicine.genericName ? (
                          <p className="text-xs text-slate-500">{medicine.genericName}</p>
                        ) : null}
                      </td>
                      <td className="td text-slate-600">{medicine.manufacturer || "—"}</td>
                      <td className="td text-slate-600">{medicine.category}</td>
                      <td className="td text-slate-600 capitalize">{medicine.unit}</td>
                      <td className="td tnum text-right">
                        <span
                          className={
                            quantity === 0
                              ? "font-semibold text-rose-600"
                              : quantity < threshold
                                ? "font-semibold text-amber-600"
                                : "font-medium text-slate-900"
                          }
                        >
                          {integer(quantity)}
                        </span>
                      </td>
                      <td className="td text-slate-600">
                        {rowStock?.nearestExpiry
                          ? formatExpiry(rowStock.nearestExpiry)
                          : "—"}
                      </td>
                      {editable ? (
                        <td className="td text-right whitespace-nowrap">
                          <Link
                            href={`/medicines?edit=${String(medicine._id)}${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
                            className="text-xs font-medium text-brand-700 hover:underline"
                          >
                            Edit
                          </Link>
                          {can(user.role, "purchase:write") ? (
                            <Link
                              href={`/purchases/new?medicineId=${String(medicine._id)}`}
                              className="ml-3 text-xs font-medium text-slate-500 hover:text-brand-700"
                            >
                              Add stock
                            </Link>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
              total={total}
              baseHref={`/medicines?${baseQuery.toString()}`}
            />
          </>
        )}
      </Card>

      {editable && (params.new === "1" || editing) ? (
        <MedicineFormPanel
          canDelete={can(user.role, "medicine:delete")}
          extraCategories={settings.medicineCategories}
          medicine={
            editing
              ? {
                  id: String(editing._id),
                  name: editing.name,
                  genericName: editing.genericName ?? "",
                  saltComposition: editing.saltComposition ?? "",
                  manufacturer: editing.manufacturer ?? "",
                  category: editing.category ?? "Other",
                  unit: editing.unit ?? "tablet",
                  packSize: editing.packSize ?? "",
                  unitsPerStrip: editing.unitsPerStrip ?? null,
                  requiresPrescription: Boolean(editing.requiresPrescription),
                  reorderLevel: editing.reorderLevel ?? null,
                  isActive: editing.isActive !== false,
                }
              : null
          }
        />
      ) : null}
    </>
  );
}
