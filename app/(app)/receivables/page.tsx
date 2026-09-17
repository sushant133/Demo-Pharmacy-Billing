import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { customerDues } from "@/lib/customer-dues";
import { withDbRead } from "@/lib/db";
import { formatDate, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import {
  Badge,
  Card,
  EmptyState,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Receivables" };
export const dynamic = "force-dynamic";

/**
 * The dues book: who owes the shop money, biggest first.
 *
 * The counterpart to /payments, which is money going out. `lib/customer-dues`
 * has computed all of this since the payment ledger landed and no screen ever
 * called it, so "who owes us?" could only be answered by paging through the
 * invoice list and adding up by eye.
 *
 * Every figure is derived from the bills on each read rather than kept as a
 * running total on the customer record - a stored balance has to be adjusted
 * by four separate writes (the sale, a later receipt, a return, a void) and
 * the first one missed leaves somebody being chased for money they do not owe.
 */

/** How many customers the table lists before it stops. */
const LIMIT = 100;

/**
 * Aging bands.
 *
 * A debt three days old is a customer who will be back on Friday; one ninety
 * days old is a different conversation, and a receivables screen that shows
 * both as the same amber number is not telling anybody which is which.
 */
function aging(oldest: Date | null): {
  days: number | null;
  label: string;
  tone: "slate" | "amber" | "rose";
} {
  if (!oldest) return { days: null, label: "—", tone: "slate" };

  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000),
  );

  if (days >= 90) return { days, label: `${days} days`, tone: "rose" };
  if (days >= 30) return { days, label: `${days} days`, tone: "amber" };
  return { days, label: days === 0 ? "Today" : `${days} days`, tone: "slate" };
}

export default async function ReceivablesPage() {
  const user = await requirePagePermission("payment:write");

  const { rows, total, unassignedDues } = await withDbRead(() =>
    customerDues(user, LIMIT),
  );

  // `total` is the sum of the rows that came back, so once the list is capped
  // it stops being the whole book. Saying so is better than quietly reporting
  // a smaller debt than the shop actually holds.
  const capped = rows.length >= LIMIT;
  const overdue = rows.filter((row) => {
    const { days } = aging(row.oldest);
    return days != null && days >= 30;
  });
  const overdueTotal = overdue.reduce((sum, row) => sum + row.outstanding, 0);
  const billCount = rows.reduce((sum, row) => sum + row.billCount, 0);

  return (
    <>
      <header className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-amber-700 text-white shadow-sm shadow-amber-900/20 sm:h-14 sm:w-14"
          >
            <svg
              className="h-6 w-6 sm:h-7 sm:w-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v18m4-14.2c-.9-1-2.5-1.6-4.5-1.6-2.8 0-4.5 1.2-4.5 3s1.7 2.7 4.5 3.2 4.5 1.4 4.5 3.2-1.7 3-4.5 3c-2 0-3.6-.6-4.5-1.6"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              Receivables
            </h1>
            <p className="mt-0.5 truncate text-sm text-slate-500">
              What customers still owe, largest first.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link href="/invoices?status=pending" className="btn-secondary">
            Unpaid invoices
          </Link>
          {can(user.role, "sale:create") ? (
            <Link href="/billing" className="btn-primary">
              New sale
            </Link>
          ) : null}
        </div>
      </header>

      <div
        className={cx(
          "mb-4 grid grid-cols-2 gap-3",
          overdueTotal > 0 ? "lg:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        <StatCard
          label="Outstanding"
          value={money(total)}
          hint={
            capped
              ? `Across the ${LIMIT} largest debtors shown`
              : `Across ${integer(billCount)} bill${billCount === 1 ? "" : "s"}`
          }
          tone={total > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Customers owing"
          value={integer(rows.length)}
          hint={capped ? `Capped at ${LIMIT}` : "Every one with a balance"}
        />
        {overdueTotal > 0 ? (
          <StatCard
            label="Over 30 days"
            value={money(overdueTotal)}
            hint={`${integer(overdue.length)} customer${overdue.length === 1 ? "" : "s"}`}
            tone="danger"
          />
        ) : null}
        <StatCard
          label="Bills to collect"
          value={integer(billCount)}
          hint="Invoices not settled in full"
        />
      </div>

      {/*
        Credit extended to nobody in particular.

        A bill left unpaid with no customer attached cannot be chased - there
        is no name and no phone number on it. It is almost always a counter
        mistake, so it is reported as its own figure rather than folded into
        the table, where it would look like a debt somebody is working on.
      */}
      {unassignedDues > 0 ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-rose-800">
            {money(unassignedDues)} is owed on bills with no customer attached.
          </p>
          <p className="mt-1 text-xs text-rose-700">
            Nobody can be chased for these - there is no name or number on them.
            They are almost always a bill put through on credit by mistake.{" "}
            <Link
              href="/invoices?status=pending"
              className="font-medium underline"
            >
              Review unpaid bills
            </Link>
            .
          </p>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="Every bill raised in a customer's name has been settled in full. Credit sales appear here the moment one is not."
            action={
              <Link href="/invoices" className="btn-secondary">
                Open invoices
              </Link>
            }
          />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr>
                  <th className="th">Customer</th>
                  <th className="th hidden sm:table-cell">Phone</th>
                  <th className="th hidden text-right lg:table-cell">Bills</th>
                  <th className="th">Oldest</th>
                  <th className="th text-right">Outstanding</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const age = aging(row.oldest);
                  // Their account page: every unpaid bill, oldest first, with
                  // the money collectable from the row. The invoice list could
                  // only be searched by name, which is not the same question.
                  const accountHref = `/receivables/${row.customerId}`;

                  return (
                    <tr key={row.customerId} className="hover:bg-slate-50">
                      <td className="td">
                        <Link
                          href={accountHref}
                          className="font-medium text-slate-900 hover:text-brand-700"
                        >
                          {row.customerName}
                        </Link>
                        <span className="tnum mt-0.5 block text-[11px] text-slate-400 sm:hidden">
                          {row.customerPhone || "No phone on file"}
                        </span>
                      </td>

                      <td className="td tnum hidden text-slate-600 sm:table-cell">
                        {row.customerPhone || "—"}
                      </td>

                      <td className="td tnum hidden text-right text-slate-600 lg:table-cell">
                        {row.billCount}
                      </td>

                      <td className="td">
                        <Badge tone={age.tone}>{age.label}</Badge>
                        {row.oldest ? (
                          <span className="tnum mt-0.5 block text-[11px] text-slate-400">
                            {formatDate(row.oldest)}
                          </span>
                        ) : null}
                      </td>

                      <td className="td tnum text-right font-semibold text-amber-700">
                        {money(row.outstanding)}
                      </td>

                      <td className="td text-right">
                        <Link
                          href={accountHref}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Collect
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>

            <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
              {capped
                ? `The ${LIMIT} largest balances. Anything smaller is not listed.`
                : `${rows.length} customer${rows.length === 1 ? "" : "s"} with a balance.`}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
