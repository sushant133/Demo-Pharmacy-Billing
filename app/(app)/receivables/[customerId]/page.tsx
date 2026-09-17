import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { formatDate, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { saleStatusFor } from "@/lib/sale-status";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { Customer } from "@/models/Customer";
import { Sale } from "@/models/Sale";
import { RecordPaymentDialog } from "@/components/sales/RecordPaymentDialog";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Customer account" };
export const dynamic = "force-dynamic";

/**
 * One customer's account: every unsettled bill, oldest first.
 *
 * The receivables list answers "who owes us"; this answers "what exactly, and
 * can I take it now". Without it, collecting a debt meant reading a name off
 * the dues book, searching the invoice list for it, and opening bills one at a
 * time to find the unpaid ones.
 *
 * Oldest first on purpose. A debt is chased from the front, and it is the bill
 * from three months ago that decides whether this customer should be sold to
 * on credit again.
 */
export default async function CustomerAccountPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const user = await requirePagePermission("payment:write");
  const { customerId } = await params;

  if (!objectIdSchema.safeParse(customerId).success) notFound();

  const { customer, unpaid, settled } = await withDbRead(async () => {
    const scope = await resolveViewScope(user);

    const customer = await Customer.findOne({
      _id: customerId,
      ...pharmacyFilter(user),
    }).lean();
    if (!customer) notFound();

    const [unpaid, settled] = await Promise.all([
      Sale.find({
        ...branchFilter(scope),
        customerId,
        voidedAt: null,
        paymentStatus: { $in: ["partial", "unpaid"] },
      })
        .sort({ createdAt: 1 })
        .limit(200)
        .lean(),
      // A little recent history, so whoever is about to chase this debt can
      // see whether the customer normally pays.
      Sale.find({
        ...branchFilter(scope),
        customerId,
        voidedAt: null,
        paymentStatus: "paid",
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

    return { customer, unpaid, settled };
  });

  const canCollect = can(user.role, "payment:write");

  const rows = unpaid.map((sale) => {
    const state = saleStatusFor(sale);
    const received =
      sale.paymentStatus == null ? sale.totalAmount : (sale.amountReceived ?? 0);
    const age = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(sale.createdAt as unknown as Date).getTime()) /
          86_400_000,
      ),
    );
    return { sale, state, received, age };
  });

  const outstanding = rows.reduce((sum, row) => sum + row.state.remaining, 0);
  const oldest = rows[0];
  const overdue = rows.filter((row) => row.age >= 30);
  const overdueTotal = overdue.reduce((sum, row) => sum + row.state.remaining, 0);

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={
          [customer.phone, customer.address].filter(Boolean).join(" · ") ||
          "Customer account"
        }
        actions={
          <>
            <Link href="/receivables" className="btn-secondary">
              Back to receivables
            </Link>
            <Link
              href={`/invoices?q=${encodeURIComponent(customer.phone || customer.name)}`}
              className="btn-secondary"
            >
              All their invoices
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={money(outstanding)}
          hint={`${integer(rows.length)} unpaid bill${rows.length === 1 ? "" : "s"}`}
          tone={outstanding > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Oldest debt"
          value={oldest ? `${integer(oldest.age)} days` : "—"}
          hint={
            oldest
              ? formatDate(oldest.sale.createdAt as unknown as Date)
              : "Nothing owing"
          }
          tone={oldest && oldest.age >= 90 ? "danger" : "default"}
        />
        <StatCard
          label="Over 30 days"
          value={money(overdueTotal)}
          hint={`${integer(overdue.length)} bill${overdue.length === 1 ? "" : "s"}`}
          tone={overdueTotal > 0 ? "danger" : "default"}
        />
        <StatCard
          label="PAN"
          value={customer.panNo || "—"}
          hint={customer.panNo ? "On file" : "Not recorded"}
        />
      </div>

      <Card className="mt-4 overflow-hidden">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
          Unpaid bills, oldest first
        </h2>

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description={`${customer.name} has settled every bill raised in their name.`}
            action={
              <Link href="/receivables" className="btn-secondary">
                Back to receivables
              </Link>
            }
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="th">Bill</th>
                <th className="th">Date</th>
                <th className="th hidden sm:table-cell">Age</th>
                <th className="th hidden lg:table-cell text-right">Total</th>
                <th className="th hidden lg:table-cell text-right">Received</th>
                <th className="th text-right">Outstanding</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ sale, state, received, age }) => {
                const id = String(sale._id);
                return (
                  <tr key={id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/sales/${id}`}
                        className="font-mono font-medium text-brand-700 hover:underline"
                      >
                        {sale.billNo}
                      </Link>
                      <span className="mt-0.5 block sm:hidden">
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </span>
                    </td>
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDate(sale.createdAt as unknown as Date)}
                    </td>
                    <td className="td hidden sm:table-cell">
                      <span
                        className={cx(
                          "tnum text-sm",
                          age >= 90
                            ? "font-semibold text-rose-600"
                            : age >= 30
                              ? "font-medium text-amber-700"
                              : "text-slate-600",
                        )}
                      >
                        {integer(age)} day{age === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td className="td tnum hidden text-right text-slate-600 lg:table-cell">
                      {money(sale.totalAmount)}
                    </td>
                    <td className="td tnum hidden text-right text-slate-600 lg:table-cell">
                      {money(received)}
                    </td>
                    <td className="td tnum text-right font-semibold text-amber-700">
                      {money(state.remaining)}
                    </td>
                    <td className="td text-right">
                      {canCollect ? (
                        <RecordPaymentDialog
                          saleId={id}
                          billNo={sale.billNo}
                          customerName={customer.name}
                          outstanding={state.remaining}
                          total={sale.totalAmount}
                          received={received}
                          variant="link"
                          label="Collect"
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="td font-semibold text-slate-900" colSpan={5}>
                  Total owing
                </td>
                <td className="td tnum text-right text-base font-bold text-amber-700">
                  {money(outstanding)}
                </td>
                <td className="td" />
              </tr>
            </tfoot>
          </TableWrap>
        )}
      </Card>

      {settled.length > 0 ? (
        <Card className="mt-4 overflow-hidden">
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            Recently settled
          </h2>
          <TableWrap>
            <thead>
              <tr>
                <th className="th">Bill</th>
                <th className="th">Date</th>
                <th className="th text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {settled.map((sale) => (
                <tr key={String(sale._id)} className="hover:bg-slate-50">
                  <td className="td">
                    <Link
                      href={`/sales/${String(sale._id)}`}
                      className="font-mono text-brand-700 hover:underline"
                    >
                      {sale.billNo}
                    </Link>
                  </td>
                  <td className="td tnum text-slate-600">
                    {formatDate(sale.createdAt as unknown as Date)}
                  </td>
                  <td className="td tnum text-right text-slate-600">
                    {money(sale.totalAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      ) : null}
    </>
  );
}
