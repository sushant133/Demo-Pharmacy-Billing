import type { Metadata } from "next";
import Link from "next/link";
import { Types } from "mongoose";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { addDays, dateInputValue } from "@/lib/dates";
import { describeExpiry, expiryTone, formatDate, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Card, EmptyState, PageHeader, Pagination, StatCard, TableWrap, cx } from "@/components/ui";
import { BatchFormPanel } from "@/components/batches/BatchFormPanel";

export const metadata: Metadata = { title: "Stock & batches" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "in-stock", label: "In stock" },
  { value: "expiring", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
] as const;

/**
 * Batch / stock register.
 *
 * This is where expiry is managed, so the table leads with the expiry column
 * and colour-codes urgency: red once expired, orange inside 30 days, amber
 * inside 90.
 */
export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    medicineId?: string;
    page?: string;
    edit?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("batch:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const status = (params.status ?? "all") as (typeof STATUS_TABS)[number]["value"];
  const editable = can(user.role, "batch:write");

  const now = new Date();

  const { batches, total, totals } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const filter: Record<string, unknown> = { ...branchFilter(scope) };

    if (status === "in-stock") {
      filter.quantity = { $gt: 0 };
      filter.expiryDate = { $gte: now };
    } else if (status === "expiring") {
      filter.quantity = { $gt: 0 };
      filter.expiryDate = { $gte: now, $lte: addDays(now, config.expiryAlertDays) };
    } else if (status === "expired") {
      filter.expiryDate = { $lt: now };
    }

    if (params.medicineId && Types.ObjectId.isValid(params.medicineId)) {
      filter.medicineId = new Types.ObjectId(params.medicineId);
    }

    if (params.q?.trim()) {
      const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(safe, "i");
      const matching = await Medicine.find({
        $or: [{ name: pattern }, { genericName: pattern }],
      })
        .select("_id")
        .lean();

      filter.$or = [
        { batchNumber: pattern },
        { medicineId: { $in: matching.map((medicine) => medicine._id) } },
      ];
    }

    const [batches, total, valueAgg] = await Promise.all([
      Batch.find(filter)
        .sort({ expiryDate: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .populate<{ medicineId: { _id: Types.ObjectId; name: string; unit?: string } }>(
          "medicineId",
          "name unit",
        )
        .lean(),
      Batch.countDocuments(filter),
      Batch.aggregate([
        { $match: { ...filter, quantity: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
            units: { $sum: "$quantity" },
          },
        },
      ]),
    ]);

    return {
      batches,
      total,
      totals: (valueAgg[0] ?? {}) as { value?: number; units?: number },
    };
  });

  const editing = params.edit
    ? batches.find((batch) => String(batch._id) === params.edit)
    : undefined;

  const baseQuery = new URLSearchParams();
  if (params.q) baseQuery.set("q", params.q);
  if (status !== "all") baseQuery.set("status", status);
  if (params.medicineId) baseQuery.set("medicineId", params.medicineId);

  return (
    <>
      <PageHeader
        title="Stock & batches"
        subtitle="Every lot on the shelf, with the delivery it arrived on. Stock enters only through a purchase."
        actions={
          editable ? (
            <Link href="/purchases/new" className="btn-primary">
              Receive stock
            </Link>
          ) : null
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Batches" value={integer(total)} tone="brand" />
        <StatCard label="Units in stock" value={integer(totals.units ?? 0)} />
        <StatCard label="Stock value (cost)" value={money(totals.value ?? 0)} />
        <StatCard
          label="Expiry window"
          value={`${config.expiryAlertDays} days`}
          hint="Configured via EXPIRY_ALERT_DAYS"
        />
      </div>

      <Card className="mb-4 p-4">
        {/* Status tabs keep the common views one click away. */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {STATUS_TABS.map((tab) => {
            const tabQuery = new URLSearchParams(baseQuery);
            if (tab.value === "all") tabQuery.delete("status");
            else tabQuery.set("status", tab.value);

            return (
              <Link
                key={tab.value}
                href={`/batches?${tabQuery.toString()}`}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  status === tab.value
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>

        <form method="get" className="grid gap-3 sm:grid-cols-3">
          {status !== "all" ? (
            <input type="hidden" name="status" value={status} />
          ) : null}
          <div className="sm:col-span-2">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Batch number or medicine name"
              className="input"
            />
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Search
            </button>
            <Link href="/batches" className="btn-secondary">
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {batches.length === 0 ? (
          <EmptyState
            title="No batches here"
            description={
              status === "expired"
                ? "Nothing has expired — good."
                : "Batches are created by posting a purchase. Record a delivery to bring stock in."
            }
            action={
              editable ? (
                <Link href="/purchases/new" className="btn-primary">
                  Receive stock
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
                  <th className="th">Batch no</th>
                  <th className="th">From GRN</th>
                  <th className="th">Expiry</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Cost</th>
                  <th className="th text-right">Sale</th>
                  <th className="th text-right">Value</th>
                  {editable ? <th className="th"></th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((batch) => {
                  const medicine = batch.medicineId as unknown as {
                    _id: Types.ObjectId;
                    name?: string;
                    unit?: string;
                  } | null;
                  const expiry = new Date(batch.expiryDate);
                  const days = Math.ceil(
                    (expiry.getTime() - now.getTime()) / 86_400_000,
                  );

                  return (
                    <tr key={String(batch._id)} className="hover:bg-slate-50">
                      <td className="td">
                        <p className="font-medium text-slate-900">
                          {medicine?.name ?? "Unknown medicine"}
                        </p>
                        <p className="text-xs text-slate-500 capitalize">
                          {medicine?.unit ?? "unit"}
                        </p>
                      </td>
                      <td className="td font-mono text-xs text-slate-700">
                        {batch.batchNumber}
                      </td>
                      <td className="td text-xs">
                        {batch.grnId ? (
                          <Link
                            href={`/purchases/${String(batch.grnId)}`}
                            className="font-mono text-brand-700 hover:underline"
                          >
                            {batch.grnNo || "View"}
                          </Link>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="td">
                        <span className="text-slate-700">{formatDate(expiry)}</span>
                        <span
                          className={cx(
                            "badge ml-2",
                            expiryTone(days),
                          )}
                        >
                          {describeExpiry(days)}
                        </span>
                      </td>
                      <td className="td tnum text-right">
                        <span
                          className={
                            batch.quantity === 0
                              ? "text-slate-400"
                              : "font-medium text-slate-900"
                          }
                        >
                          {integer(batch.quantity)}
                        </span>
                        {batch.initialQuantity > 0 ? (
                          <span className="ml-1 text-xs text-slate-400">
                            / {integer(batch.initialQuantity)}
                          </span>
                        ) : null}
                      </td>
                      <td className="td tnum text-right text-slate-600">
                        {money(batch.costPrice)}
                      </td>
                      <td className="td tnum text-right text-slate-900">
                        {money(batch.salePrice)}
                      </td>
                      <td className="td tnum text-right text-slate-600">
                        {money(batch.quantity * batch.costPrice)}
                      </td>
                      {editable ? (
                        <td className="td text-right">
                          <Link
                            href={`/batches?edit=${String(batch._id)}${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
                            className="text-xs font-medium text-brand-700 hover:underline"
                          >
                            Edit
                          </Link>
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
              baseHref={`/batches?${baseQuery.toString()}`}
            />
          </>
        )}
      </Card>

      {editable && editing ? (
        <BatchFormPanel
          canDelete={can(user.role, "batch:delete")}
          batch={{
            id: String(editing._id),
            medicineName:
              (editing.medicineId as unknown as { name?: string } | null)?.name ??
              "Unknown medicine",
            batchNumber: editing.batchNumber,
            mfgDate: dateInputValue(editing.mfgDate),
            expiryDate: dateInputValue(editing.expiryDate),
            quantity: editing.quantity,
            costPrice: editing.costPrice,
            salePrice: editing.salePrice,
            notes: editing.notes ?? "",
            grnNo: editing.grnNo ?? "",
          }}
        />
      ) : null}
    </>
  );
}
