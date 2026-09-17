import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { formatDate, integer, money } from "@/lib/format";
import { getBalancesFor, getTotalPayables } from "@/lib/suppliers";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  TableWrap,
} from "@/components/ui";

export const metadata: Metadata = { title: "Payables" };
export const dynamic = "force-dynamic";

/**
 * The creditors book: who the shop owes, biggest first.
 *
 * The exact mirror of /receivables, and built on the same principle - every
 * figure is derived on each read rather than stored. `lib/suppliers` has
 * computed supplier balances since the ledger landed, but the only way to see
 * them was one supplier at a time, so "what do we owe this month?" meant
 * opening each supplier in turn and adding up by eye.
 *
 *   owed = opening balance + posted deliveries - goods returned - payments
 *
 * Drafts are excluded because a draft is not yet a liability, and cancelled
 * GRNs because they never were.
 */

/** How many suppliers the table lists before it stops. */
const LIMIT = 100;

/**
 * Aging on an overdue balance.
 *
 * A supplier invoice a week past its date is a payment run that has not
 * happened yet; one sixty days past is a relationship problem, and a screen
 * that paints both the same amber is not saying which is which.
 */
function aging(oldestDue: Date | null): {
  label: string;
  tone: "slate" | "amber" | "rose";
} {
  if (!oldestDue) return { label: "—", tone: "slate" };

  const days = Math.floor(
    (Date.now() - new Date(oldestDue).getTime()) / 86_400_000,
  );
  if (days <= 0) return { label: "Not yet due", tone: "slate" };
  if (days <= 30) return { label: `${days}d overdue`, tone: "amber" };
  return { label: `${days}d overdue`, tone: "rose" };
}

export default async function PayablesPage() {
  const user = await requirePagePermission("payment:write");

  const { rows, totals } = await withDbRead(async () => {
    const pharmacyId = pharmacyObjectId(user);

    const [suppliers, totals] = await Promise.all([
      Supplier.find({ ...pharmacyFilter(user), isActive: { $ne: false } })
        .select("_id name phone openingBalance creditDays")
        .lean(),
      getTotalPayables(user),
    ]);

    const balances = await getBalancesFor(
      suppliers.map((supplier) => supplier._id),
      pharmacyId,
    );

    // The oldest unpaid due date per supplier, which is what the aging column
    // reads. One grouped query rather than one per supplier.
    const overdue = await Purchase.aggregate<{
      _id: unknown;
      oldestDue: Date | null;
      unpaidCount: number;
    }>([
      {
        $match: {
          ...pharmacyFilter(user),
          status: "posted",
          paymentStatus: { $ne: "paid" },
        },
      },
      {
        $group: {
          _id: "$supplierId",
          oldestDue: { $min: "$dueDate" },
          unpaidCount: { $sum: 1 },
        },
      },
    ]);

    const overdueBy = new Map(
      overdue.map((row) => [
        String(row._id),
        { oldestDue: row.oldestDue, unpaidCount: row.unpaidCount },
      ]),
    );

    const rows = suppliers
      .map((supplier) => {
        const id = String(supplier._id);
        const balance = balances.get(id) ?? {
          purchased: 0,
          returned: 0,
          paid: 0,
        };
        const outstanding =
          (supplier.openingBalance ?? 0) +
          balance.purchased -
          balance.returned -
          balance.paid;
        const extra = overdueBy.get(id);

        return {
          id,
          name: supplier.name,
          phone: supplier.phone ?? "",
          purchased: balance.purchased,
          returned: balance.returned,
          paid: balance.paid,
          outstanding: Math.round(outstanding * 100) / 100,
          oldestDue: (extra?.oldestDue as Date | null) ?? null,
          unpaidCount: extra?.unpaidCount ?? 0,
        };
      })
      // Settled suppliers are not payables. A supplier in credit (negative) is
      // kept, because money sitting with a supplier is worth chasing too.
      .filter((row) => Math.abs(row.outstanding) >= 0.01)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, LIMIT);

    return { rows, totals };
  });

  const inCredit = rows.filter((row) => row.outstanding < 0).length;

  return (
    <>
      <PageHeader
        title="Payables"
        subtitle="What this pharmacy owes its suppliers."
        actions={
          <Link href="/payments" className="btn-primary">
            Record a payment
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total owed" value={money(totals.outstanding)} />
        <StatCard
          label="Overdue"
          value={money(totals.overdue)}
          tone={totals.overdue > 0 ? "warning" : "default"}
        />
        <StatCard label="Suppliers with a balance" value={integer(rows.length)} />
        <StatCard
          label="In credit to you"
          value={integer(inCredit)}
          hint={inCredit > 0 ? "You have paid ahead" : undefined}
        />
      </div>

      <Card className="mt-4 overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="Every supplier is settled. Deliveries you post on credit will appear here until they are paid."
            action={
              <Link href="/purchases" className="btn-primary">
                Open purchases
              </Link>
            }
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="th">Supplier</th>
                <th className="th hidden lg:table-cell">Phone</th>
                <th className="th hidden text-right sm:table-cell">Delivered</th>
                <th className="th hidden text-right xl:table-cell">Returned</th>
                <th className="th hidden text-right sm:table-cell">Paid</th>
                <th className="th text-right">Outstanding</th>
                <th className="th text-right">Oldest unpaid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const age = aging(row.oldestDue);
                const credit = row.outstanding < 0;

                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        href={`/suppliers/${row.id}`}
                        className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.unpaidCount > 0 ? (
                        <span className="block text-[11px] text-slate-500">
                          {row.unpaidCount} unpaid delivery
                          {row.unpaidCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </td>
                    <td className="td hidden text-slate-500 lg:table-cell">
                      {row.phone || "—"}
                    </td>
                    <td className="td tnum hidden text-right text-slate-600 sm:table-cell">
                      {money(row.purchased)}
                    </td>
                    <td className="td tnum hidden text-right text-slate-600 xl:table-cell">
                      {row.returned > 0 ? money(row.returned) : "—"}
                    </td>
                    <td className="td tnum hidden text-right text-slate-600 sm:table-cell">
                      {money(row.paid)}
                    </td>
                    <td className="td tnum text-right font-semibold text-slate-900">
                      {credit ? (
                        <span className="text-emerald-700">
                          {money(Math.abs(row.outstanding))} cr
                        </span>
                      ) : (
                        money(row.outstanding)
                      )}
                    </td>
                    <td className="td text-right">
                      {credit ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <>
                          <Badge tone={age.tone}>{age.label}</Badge>
                          {row.oldestDue ? (
                            <span className="mt-0.5 block text-[11px] text-slate-400">
                              {formatDate(row.oldestDue)}
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
