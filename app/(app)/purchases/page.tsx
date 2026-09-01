import type { Metadata } from "next";
import Link from "next/link";
import { Types } from "mongoose";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { dateRangeFromStrings } from "@/lib/dates";
import { formatDate, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  PAYMENT_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  type PaymentStatus,
  type PurchaseStatus,
} from "@/lib/constants";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Purchases" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
] as const;

/** Purchase register: every delivery, and what is still owed on it. */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    paymentStatus?: string;
    supplierId?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("purchase:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const status = (params.status ?? "all") as (typeof STATUS_TABS)[number]["value"];
  const canWrite = can(user.role, "purchase:write");

  const { purchases, total, purchased, paid, units, suppliers } = await withDbRead(
    async () => {
      const scope = await resolveViewScope(user, params.branch);
      const filter: Record<string, unknown> = { ...branchFilter(scope) };
      if (status !== "all") filter.status = status;

      if (params.paymentStatus && params.paymentStatus !== "all") {
        filter.paymentStatus = params.paymentStatus;
        filter.status = status !== "all" ? status : "posted";
      }

      if (params.supplierId && Types.ObjectId.isValid(params.supplierId)) {
        filter.supplierId = new Types.ObjectId(params.supplierId);
      }

      const { start, end } = dateRangeFromStrings(params.from, params.to);
      if (start || end) {
        const range: Record<string, Date> = {};
        if (start) range.$gte = start;
        if (end) range.$lt = end;
        filter.receivedDate = range;
      }

      if (params.q?.trim()) {
        const safe = params.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(safe, "i");
        filter.$or = [
          { grnNo: pattern },
          { invoiceNo: pattern },
          { supplierName: pattern },
          { "items.medicineName": pattern },
          { "items.batchNumber": pattern },
        ];
      }

      const [purchases, total, summaryAgg, suppliers] = await Promise.all([
        Purchase.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .lean(),
        Purchase.countDocuments(filter),
        Purchase.aggregate([
          { $match: { ...filter, status: "posted" } },
          {
            $group: {
              _id: null,
              purchased: { $sum: "$totalAmount" },
              paid: { $sum: "$amountPaid" },
              units: {
                $sum: {
                  $sum: {
                    $map: {
                      input: "$items",
                      as: "item",
                      in: { $add: ["$$item.quantity", "$$item.freeQuantity"] },
                    },
                  },
                },
              },
            },
          },
        ]),
        Supplier.find().sort({ name: 1 }).select("name").limit(300).lean(),
      ]);

      const summary = (summaryAgg[0] ?? {}) as {
        purchased?: number;
        paid?: number;
        units?: number;
      };

      return {
        purchases,
        total,
        purchased: summary.purchased ?? 0,
        paid: summary.paid ?? 0,
        units: summary.units ?? 0,
        suppliers,
      };
    },
  );

  const baseQuery = new URLSearchParams();
  if (status !== "all") baseQuery.set("status", status);
  if (params.paymentStatus) baseQuery.set("paymentStatus", params.paymentStatus);
  if (params.supplierId) baseQuery.set("supplierId", params.supplierId);
  if (params.from) baseQuery.set("from", params.from);
  if (params.to) baseQuery.set("to", params.to);
  if (params.q) baseQuery.set("q", params.q);

  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Every delivery received. Posting a purchase is what puts stock on the shelf."
        actions={
          canWrite ? (
            <Link href="/purchases/new" className="btn-primary">
              New purchase
            </Link>
          ) : null
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Purchases" value={integer(total)} tone="brand" />
        <StatCard label="Posted value" value={money(purchased)} />
        <StatCard
          label="Still owed"
          value={money(purchased - paid)}
          tone={purchased - paid > 0 ? "warning" : "default"}
        />
        <StatCard label="Units received" value={integer(units)} />
      </div>

      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {STATUS_TABS.map((tab) => {
            const tabQuery = new URLSearchParams(baseQuery);
            if (tab.value === "all") tabQuery.delete("status");
            else tabQuery.set("status", tab.value);
            tabQuery.delete("page");

            return (
              <Link
                key={tab.value}
                href={`/purchases?${tabQuery.toString()}`}
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

        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
          <div>
            <label htmlFor="supplierId" className="label">
              Supplier
            </label>
            <select
              id="supplierId"
              name="supplierId"
              defaultValue={params.supplierId ?? ""}
              className="input"
            >
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => (
                <option key={String(supplier._id)} value={String(supplier._id)}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="paymentStatus" className="label">
              Payment
            </label>
            <select
              id="paymentStatus"
              name="paymentStatus"
              defaultValue={params.paymentStatus ?? ""}
              className="input"
            >
              <option value="">Any</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Partly paid</option>
              <option value="paid">Paid</option>
            </select>
          </div>
          <div>
            <label htmlFor="from" className="label">
              From
            </label>
            <input
              id="from"
              type="date"
              name="from"
              defaultValue={params.from ?? ""}
              className="input"
            />
          </div>
          <div>
            <label htmlFor="to" className="label">
              To
            </label>
            <input
              id="to"
              type="date"
              name="to"
              defaultValue={params.to ?? ""}
              className="input"
            />
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Filter
            </button>
            <Link href="/purchases" className="btn-secondary">
              Reset
            </Link>
          </div>

          <div className="sm:col-span-2 lg:col-span-5">
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search GRN no, supplier invoice, medicine or batch number"
              className="input"
              aria-label="Search purchases"
            />
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {purchases.length === 0 ? (
          <EmptyState
            title="No purchases here"
            description={
              status === "draft"
                ? "No drafts waiting. Drafts let you type an invoice before the delivery is fully checked."
                : "Record a delivery to bring stock into the shop."
            }
            action={
              canWrite ? (
                <Link href="/purchases/new" className="btn-primary">
                  New purchase
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap>
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">GRN no</th>
                  <th className="th">Supplier</th>
                  <th className="th">Invoice</th>
                  <th className="th">Received</th>
                  <th className="th text-right">Units</th>
                  <th className="th text-right">Total</th>
                  <th className="th">Status</th>
                  <th className="th">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {purchases.map((purchase) => {
                  const units = purchase.items.reduce(
                    (sum, item) => sum + item.quantity + item.freeQuantity,
                    0,
                  );
                  const overdue =
                    purchase.status === "posted" &&
                    purchase.paymentStatus !== "paid" &&
                    purchase.dueDate &&
                    new Date(purchase.dueDate).getTime() < now;

                  return (
                    <tr key={String(purchase._id)} className="hover:bg-slate-50">
                      <td className="td">
                        <Link
                          href={`/purchases/${String(purchase._id)}`}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {purchase.grnNo}
                        </Link>
                      </td>
                      <td className="td font-medium text-slate-900">
                        {purchase.supplierName}
                      </td>
                      <td className="td text-slate-600">{purchase.invoiceNo || "—"}</td>
                      <td className="td whitespace-nowrap text-slate-600">
                        {formatDate(purchase.receivedDate)}
                      </td>
                      <td className="td tnum text-right">{integer(units)}</td>
                      <td className="td tnum text-right font-semibold text-slate-900">
                        {money(purchase.totalAmount)}
                      </td>
                      <td className="td">
                        <Badge
                          tone={
                            purchase.status === "posted"
                              ? "green"
                              : purchase.status === "draft"
                                ? "amber"
                                : "rose"
                          }
                        >
                          {PURCHASE_STATUS_LABELS[purchase.status as PurchaseStatus] ??
                            purchase.status}
                        </Badge>
                      </td>
                      <td className="td">
                        {purchase.status === "posted" ? (
                          <Badge
                            tone={
                              purchase.paymentStatus === "paid"
                                ? "green"
                                : overdue
                                  ? "rose"
                                  : "slate"
                            }
                          >
                            {overdue
                              ? "Overdue"
                              : (PAYMENT_STATUS_LABELS[
                                  purchase.paymentStatus as PaymentStatus
                                ] ?? purchase.paymentStatus)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
              total={total}
              baseHref={`/purchases?${baseQuery.toString()}`}
            />
          </>
        )}
      </Card>
    </>
  );
}
