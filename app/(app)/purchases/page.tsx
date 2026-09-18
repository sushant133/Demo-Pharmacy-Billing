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
import { pharmacyFilter } from "@/lib/tenant";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { DualDateField } from "@/components/DualDateField";
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

/**
 * Columns the register may be ordered by.
 *
 * A whitelist, not a passthrough: `sort` arrives from the query string, and
 * handing an arbitrary string to Mongo would let a crafted URL order by
 * anything on the document.
 */
const SORT_FIELDS = {
  grn: "grnSeq",
  supplier: "supplierName",
  received: "receivedDate",
  total: "totalAmount",
  due: "dueDate",
} as const;

type SortKey = keyof typeof SORT_FIELDS;

function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && value in SORT_FIELDS;
}

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
    sort?: string;
    dir?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("purchase:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const status = (params.status ?? "all") as (typeof STATUS_TABS)[number]["value"];
  const canWrite = can(user.role, "purchase:write");
  const canPay = can(user.role, "payment:write");

  // Newest delivery first is what a register is for; the rest is opt-in.
  const sort: SortKey = isSortKey(params.sort) ? params.sort : "received";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";

  const { purchases, total, purchased, paid, units, suppliers } = await withDbRead(
    async () => {
      const scope = await resolveViewScope(user, params.branch);
      const filter: Record<string, unknown> = {
        ...pharmacyFilter(user),
        ...branchFilter(scope),
      };
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
          // `_id` breaks ties: two deliveries keyed the same afternoon would
          // otherwise shuffle between pages, repeating one row and dropping
          // another.
          .sort({ [SORT_FIELDS[sort]]: dir === "asc" ? 1 : -1, _id: -1 })
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
        Supplier.find(pharmacyFilter(user)).sort({ name: 1 }).select("name").limit(300).lean(),
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
  if (sort !== "received") baseQuery.set("sort", sort);
  if (dir !== "desc") baseQuery.set("dir", dir);

  /** Clicking the sorted column flips it; a new one starts the sensible way. */
  const sortHref = (key: SortKey) => {
    const query = new URLSearchParams(baseQuery);
    query.set("sort", key);
    query.set(
      "dir",
      sort === key ? (dir === "asc" ? "desc" : "asc") : key === "supplier" ? "asc" : "desc",
    );
    query.delete("page");
    return `/purchases?${query.toString()}`;
  };

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

        <form method="get" className="space-y-3">
          {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="label">From</p>
              <DualDateField
                id="from"
                name="from"
                defaultValue={params.from ?? ""}
                compact
                aria-label="From"
              />
            </div>
            <div className="min-w-0">
              <p className="label">To</p>
              <DualDateField
                id="to"
                name="to"
                defaultValue={params.to ?? ""}
                compact
                aria-label="To"
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search GRN no, supplier invoice, medicine or batch number"
              className="input min-w-0 flex-1"
              aria-label="Search purchases"
            />
            <div className="flex shrink-0 gap-2">
              <button type="submit" className="btn-primary">
                Filter
              </button>
              <Link href="/purchases" className="btn-secondary">
                Reset
              </Link>
            </div>
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
            <TableWrap minWidth="58rem" pinFirst pinLast>
              <thead className="border-b border-slate-200 bg-slate-50">
                {/*
                  Ten columns. A phone keeps the GRN number, the total, where
                  the delivery stands and what can be done with it; the
                  supplier and the received date fold under the number, and
                  the rest - invoice number, units, amount due, payment badge -
                  come back as the screen earns them.

                  Hiding a sortable heading also removes its sort control at
                  that width, which is correct: a column you cannot see is not
                  one you want to order by.
                */}
                <tr>
                  <SortableTh label="GRN no" href={sortHref("grn")} active={sort === "grn"} dir={dir} />
                  <SortableTh label="Supplier" href={sortHref("supplier")} active={sort === "supplier"} dir={dir} />
                  <th className="th">Invoice</th>
                  <SortableTh label="Received" href={sortHref("received")} active={sort === "received"} dir={dir} />
                  <th className="th text-right">Units</th>
                  <SortableTh label="Total" href={sortHref("total")} active={sort === "total"} dir={dir} align="right" />
                  <SortableTh label="Due" href={sortHref("due")} active={sort === "due"} dir={dir} align="right" />
                  <th className="th">Status</th>
                  <th className="th">Payment</th>
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {purchases.map((purchase) => {
                  const units = purchase.items.reduce(
                    (sum, item) => sum + item.quantity + item.freeQuantity,
                    0,
                  );
                  const overdue = Boolean(
                    purchase.status === "posted" &&
                      purchase.paymentStatus !== "paid" &&
                      purchase.dueDate &&
                      new Date(purchase.dueDate).getTime() < now,
                  );

                  const id = String(purchase._id);
                  // Net of anything sent back on a debit note, which is what
                  // the supplier ledger also nets off.
                  const outstanding = Math.max(
                    0,
                    Math.round(
                      (purchase.totalAmount -
                        (purchase.returnedTotal ?? 0) -
                        (purchase.amountPaid ?? 0)) *
                        100,
                    ) / 100,
                  );

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
                      <td className="td text-slate-600">
                        {purchase.invoiceNo || "—"}
                      </td>
                      <td className="td whitespace-nowrap text-slate-600">
                        {formatDate(purchase.receivedDate)}
                      </td>
                      <td className="td tnum text-right">
                        {integer(units)}
                      </td>
                      <td className="td tnum text-right font-semibold text-slate-900">
                        {money(purchase.totalAmount)}
                      </td>

                      {/*
                        What is still owed on this delivery, netted of anything
                        sent back. Only a posted GRN owes anything: a draft is
                        not yet a liability and a cancelled one never was.
                      */}
                      <td className="td tnum text-right">
                        {purchase.status === "posted" ? (
                          outstanding > 0 ? (
                            <span
                              className={
                                overdue
                                  ? "font-semibold text-rose-600"
                                  : "font-medium text-amber-700"
                              }
                            >
                              {money(outstanding)}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
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

                      {/*
                        Only the actions the state actually permits.

                        A posted GRN cannot be edited - it is an accounting
                        document with stock behind it - so Edit appears on
                        drafts alone, and correcting a posted one goes through
                        cancellation on the detail screen where a reason is
                        required. Record payment appears only where something
                        is genuinely owed. Rather than greying out four
                        controls on every row, each is simply absent when it
                        would not work.
                      */}
                      <td className="td col-actions">
                        <ActionBar>
                          <ActionIcon
                            label="View details"
                            icon="view"
                            tone="primary"
                            href={`/purchases/${id}`}
                          />

                          {canWrite && purchase.status === "draft" ? (
                            <ActionIcon
                              label="Edit"
                              icon="edit"
                              href={`/purchases/${id}/edit`}
                            />
                          ) : null}

                          {canPay && purchase.status === "posted" && outstanding > 0 ? (
                            <ActionIcon
                              label="Record payment"
                              icon="money"
                              href={`/payments?supplierId=${String(purchase.supplierId)}&purchaseId=${id}`}
                            />
                          ) : null}
                        </ActionBar>
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

/**
 * A column heading that sorts.
 *
 * `aria-sort` carries to a screen reader what the arrow carries to everyone
 * else - that the table is ordered, and which way.
 */
function SortableTh({
  label,
  href,
  active,
  dir,
  align = "left",
  className,
}: {
  label: string;
  href: string;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={cx("th", align === "right" && "text-right", className)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={href}
        scroll={false}
        className={cx(
          "group inline-flex items-center gap-1 transition-colors hover:text-slate-900",
          align === "right" && "flex-row-reverse",
          active && "text-slate-900",
        )}
      >
        {label}
        <svg
          className={cx(
            "h-3 w-3 shrink-0 transition",
            active
              ? "text-brand-600"
              : "text-slate-300 opacity-0 group-hover:opacity-100",
            active && dir === "asc" && "rotate-180",
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-6-6m6 6l6-6" />
        </svg>
      </Link>
    </th>
  );
}
