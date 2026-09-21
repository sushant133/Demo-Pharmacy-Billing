import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { pharmacyFilter } from "@/lib/tenant";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { formatExpiry, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { mergeMedicineCategories } from "@/lib/constants";
import { getLowStock } from "@/lib/reports";
import { getSettings } from "@/lib/settings";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Badge, Card, EmptyState, PageHeader, Pagination, TableWrap } from "@/components/ui";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { MedicineFormPanel } from "@/components/medicines/MedicineFormPanel";
import { MedicineImportPanel } from "@/components/medicines/MedicineImportPanel";
import { MedicineActiveToggle } from "@/components/medicines/MedicineActiveToggle";

export const metadata: Metadata = { title: "Medicines" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Whether a catalogue entry may still be sold.
 *
 * "Inactive" is not a stock state - it is a decision the shop made about the
 * product, and the till refuses it whatever is on the shelf. Kept separate
 * from the In-stock column for exactly that reason: a line can be well stocked
 * and still unsellable, and a screen that shows only the quantity will not say
 * why billing keeps rejecting it.
 */
const CATALOGUE_STATUSES = ["all", "active", "inactive"] as const;
type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];

const CATALOGUE_STATUS_LABELS: Record<CatalogueStatus, string> = {
  all: "Active and inactive",
  active: "Active only",
  inactive: "Inactive only",
};

function isCatalogueStatus(value: unknown): value is CatalogueStatus {
  return (
    typeof value === "string" &&
    (CATALOGUE_STATUSES as readonly string[]).includes(value)
  );
}

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
    status?: string;
    view?: string;
    page?: string;
    new?: string;
    edit?: string;
    import?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("medicine:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const lowStockView = params.view === "low-stock";
  const editable = can(user.role, "medicine:write");
  const status: CatalogueStatus = isCatalogueStatus(params.status)
    ? params.status
    : "all";

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
              <TableWrap minWidth="42rem" pinFirst pinLast>
                <thead className="border-b border-slate-200 bg-slate-50">
                  {/*
                    A phone keeps the three that make the decision - what it
                    is, how little is left, and what to do about it. The
                    reorder level is folded in beside the quantity it is
                    being judged against, where it is more use than in a
                    column of its own anyway.
                  */}
                  <tr>
                    <th className="th">Medicine</th>
                    <th className="th">Category</th>
                    <th className="th text-right">In stock</th>
                    <th className="th text-right">Reorder at</th>
                    <th className="th text-right">Batches</th>
                    <th className="th">Nearest expiry</th>
                    {can(user.role, "purchase:write") ? (
                      <th className="th text-right col-actions">Actions</th>
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
                      <td className="td text-slate-600">
                        {row.category}
                      </td>
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
                        <td className="td col-actions">
                          <ActionBar>
                            <ActionIcon
                              label="Add stock"
                              icon="add"
                              tone="primary"
                              href={`/purchases/new?medicineId=${row.medicineId}`}
                            />
                          </ActionBar>
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
    // A discontinued line stays in the catalogue so its history reads, but a
    // shop with hundreds of them wants the working list by default. Explicit
    // rather than assumed: "all" is a real choice, not the absence of one.
    if (status === "active") filter.isActive = { $ne: false };
    if (status === "inactive") filter.isActive = false;
    if (params.q?.trim()) {
      const query = params.q.trim();
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(safe, "i");
      filter.$or = [
        { name: pattern },
        { genericName: pattern },
        { saltComposition: pattern },
        { manufacturer: pattern },
        // Codes are matched whole, not as fragments: "500" out of a barcode
        // would otherwise pull up every 500mg line in the catalogue.
        { barcode: query },
        { sku: query.toUpperCase() },
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
      price: number | null;
      minPrice: number | null;
      maxPrice: number | null;
    }>([
      {
        $match: {
          medicineId: { $in: medicines.map((medicine) => medicine._id) },
          quantity: { $gt: 0 },
          expiryDate: { $gte: now },
          ...branchFilter(scope),
        },
      },
      /*
        FEFO order, so `$first` below is the batch the till would actually
        reach for next - and therefore the price a customer pays today.

        Selling price lives on the batch, not the medicine: a delivery bought
        at a new rate is priced when it is received, and the old lot keeps the
        price it was sold at. So there is no single "the price" to read off the
        catalogue, and this is the nearest honest answer. The sort mirrors
        `compareFefo` in lib/fefo.ts - earliest expiry, then oldest batch, then
        id - because a price that disagreed with the till would be worse than
        showing none at all.
      */
      { $sort: { expiryDate: 1, createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: "$medicineId",
          quantity: { $sum: "$quantity" },
          nearestExpiry: { $first: "$expiryDate" },
          price: { $first: "$salePrice" },
          // When the lots on the shelf disagree, the row says so rather than
          // quietly presenting one of them as the price.
          minPrice: { $min: "$salePrice" },
          maxPrice: { $max: "$salePrice" },
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
          {
            quantity: row.quantity,
            nearestExpiry: row.nearestExpiry,
            price: row.price,
            minPrice: row.minPrice,
            maxPrice: row.maxPrice,
          },
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
  if (status !== "all") baseQuery.set("status", status);

  // The same filters plus the page, which is what "put me back where I was"
  // actually means. `baseQuery` deliberately omits the page, because that is
  // the one thing pagination links have to replace.
  const listQuery = new URLSearchParams(baseQuery);
  if (page > 1) listQuery.set("page", String(page));
  const listHref = listQuery.toString()
    ? `/medicines?${listQuery.toString()}`
    : "/medicines";

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
              <Link
                href={`/medicines?import=1${listQuery.toString() ? "&" + listQuery.toString() : ""}`}
                className="btn-secondary"
              >
                <svg
                  className="h-4 w-4 text-slate-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                  />
                </svg>
                Bulk import
              </Link>
            ) : null}
            {editable ? (
              /* Carries the current filters, so Cancel returns to this list. */
              <Link
                href={`/medicines?new=1${listQuery.toString() ? "&" + listQuery.toString() : ""}`}
                className="btn-primary"
              >
                Add medicine
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-4 p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Name, salt, maker, code or barcode"
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
          <div>
            <label htmlFor="status" className="label">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={status}
              className="input"
            >
              {CATALOGUE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {CATALOGUE_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Filter
            </button>
            {params.q || params.category || status !== "all" ? (
              <Link href="/medicines" className="btn-secondary">
                Reset
              </Link>
            ) : null}
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
            <TableWrap minWidth="54rem" pinFirst pinLast>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Medicine</th>
                  <th className="th">Manufacturer</th>
                  <th className="th">Category</th>
                  <th className="th">Unit</th>
                  <th className="th text-right">Selling price</th>
                  <th className="th text-right">In stock</th>
                  <th className="th">Status</th>
                  <th className="th">Nearest expiry</th>
                  {editable ? (
                    <th className="th text-right col-actions">Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {medicines.map((medicine) => {
                  const rowStock = stock.get(String(medicine._id));
                  const quantity = rowStock?.quantity ?? 0;
                  const threshold = medicine.reorderLevel ?? config.lowStockThreshold;
                  const price = rowStock?.price ?? null;
                  const mixedPrices =
                    rowStock?.minPrice != null &&
                    rowStock.maxPrice != null &&
                    rowStock.minPrice !== rowStock.maxPrice;

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
                          {/*
                            Rx stays on the name, where the eye already is when
                            somebody is checking what they are about to sell.
                            Active/inactive has moved to its own column.
                          */}
                          {medicine.requiresPrescription ? (
                            <Badge tone="amber" className="ml-2">
                              Rx
                            </Badge>
                          ) : null}
                        </p>
                        {medicine.genericName ? (
                          <p className="text-xs text-slate-500">{medicine.genericName}</p>
                        ) : null}
                        {/*
                          The shop's own code, under the name rather than in a
                          column of its own: most shops fill it for some lines
                          and not others, and an empty column of dashes costs
                          more width than it earns.
                        */}
                        {medicine.sku ? (
                          <p className="mt-0.5 font-mono text-[11px] tracking-wide text-slate-400">
                            {medicine.sku}
                          </p>
                        ) : null}
                      </td>
                      <td className="td text-slate-600">
                        {medicine.manufacturer || "—"}
                      </td>
                      <td className="td text-slate-600">
                        {medicine.category}
                      </td>
                      <td className="td text-slate-600 capitalize">
                        {medicine.unit}
                      </td>
                      <td className="td tnum text-right">
                        {price == null ? (
                          // No sellable batch, so nothing has a price yet. Not
                          // a zero: zero is a real price somebody could set.
                          <span className="text-slate-400">—</span>
                        ) : (
                          <>
                            <span className="font-medium text-slate-900">
                              {money(price)}
                            </span>
                            {mixedPrices ? (
                              <span
                                className="block text-[11px] text-slate-400"
                                title="The lots on the shelf carry different prices. The till charges the one dispensed first."
                              >
                                {money(rowStock!.minPrice!)}–
                                {money(rowStock!.maxPrice!)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </td>
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
                      <td className="td">
                        {medicine.isActive === false ? (
                          <Badge tone="slate">Inactive</Badge>
                        ) : (
                          <Badge tone="green">Active</Badge>
                        )}
                      </td>
                      <td className="td text-slate-600">
                        {rowStock?.nearestExpiry
                          ? formatExpiry(rowStock.nearestExpiry)
                          : "—"}
                      </td>
                      {editable ? (
                        <td className="td col-actions">
                          <ActionBar>
                            <ActionIcon
                              label="Edit"
                              icon="edit"
                              tone="primary"
                              href={`/medicines?edit=${String(medicine._id)}${listQuery.toString() ? "&" + listQuery.toString() : ""}`}
                            />
                            {can(user.role, "purchase:write") ? (
                              <ActionIcon
                                label="Add stock"
                                icon="add"
                                href={`/purchases/new?medicineId=${String(medicine._id)}`}
                              />
                            ) : null}
                            <MedicineActiveToggle
                              id={String(medicine._id)}
                              name={medicine.name}
                              isActive={medicine.isActive !== false}
                              stockQuantity={quantity}
                            />
                          </ActionBar>
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
          // The list exactly as it was, so closing the panel puts the user back
          // where they were rather than on an unfiltered page 1.
          returnHref={listHref}
          medicine={
            editing
              ? {
                  id: String(editing._id),
                  sku: editing.sku ?? "",
                  name: editing.name,
                  genericName: editing.genericName ?? "",
                  saltComposition: editing.saltComposition ?? "",
                  manufacturer: editing.manufacturer ?? "",
                  category: editing.category ?? "Other",
                  unit: editing.unit ?? "tablet",
                  packSize: editing.packSize ?? "",
                  barcode: editing.barcode ?? "",
                  unitsPerStrip: editing.unitsPerStrip ?? null,
                  defaultCostPrice: editing.defaultCostPrice ?? null,
                  defaultSalePrice: editing.defaultSalePrice ?? null,
                  requiresPrescription: Boolean(editing.requiresPrescription),
                  reorderLevel: editing.reorderLevel ?? null,
                  isActive: editing.isActive !== false,
                }
              : null
          }
        />
      ) : null}

      {editable && params.import === "1" ? (
        <MedicineImportPanel returnHref={listHref} />
      ) : null}
    </>
  );
}
