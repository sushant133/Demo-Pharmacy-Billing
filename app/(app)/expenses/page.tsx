import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import {
  dateInputValue,
  dateRangeFromStrings,

  toDateInputValue,
} from "@/lib/dates";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_METHOD_LABELS,
  isExpenseCategory,
  type ExpenseCategory,
  type ExpenseMethod,
} from "@/lib/expense-categories";
import { expenseTotals } from "@/lib/expenses";
import { formatDate, integer, money } from "@/lib/format";
import { Expense } from "@/models/Expense";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { ExpenseFormPanel } from "@/components/finance/ExpenseFormPanel";
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

export const metadata: Metadata = { title: "Expenses" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Running costs: rent, salaries, electricity - the things that are not stock.
 *
 * The books here have always run on goods, which makes gross margin honest and
 * net profit fiction, because nothing subtracted the cost of keeping the door
 * open. This is the screen that closes that gap.
 *
 * Defaults to this month. An expense register is read a month at a time -
 * "what did Ashadh cost us?" - not a day at a time like a sales list.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    category?: string;
    page?: string;
    new?: string;
    edit?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("report:financial");
  const params = await searchParams;

  const today = toDateInputValue();
  const monthStart = `${today.slice(0, 7)}-01`;

  const askedFrom = (params.from ?? monthStart).trim();
  const askedTo = (params.to ?? today).trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const page = Math.max(1, Number(params.page) || 1);
  const category = isExpenseCategory(params.category) ? params.category : null;

  const { rows, total, totals, previous } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const { start, end } = dateRangeFromStrings(from, to);
    const rangeStart = start ?? new Date(0);
    const rangeEnd = end ?? new Date();

    const filter: Record<string, unknown> = {
      ...branchFilter(scope),
      paidOn: { $gte: rangeStart, $lt: rangeEnd },
    };
    if (category) filter.category = category;

    /*
      The same length of time immediately before this range.

      A month's costs mean little on their own; what an owner wants to know is
      whether they went up. Derived from the range itself so it stays a like
      for like comparison however the dates are set.
    */
    const span = Math.max(1, rangeEnd.getTime() - rangeStart.getTime());
    const priorStart = new Date(rangeStart.getTime() - span);

    const [rows, total, totals, previous] = await Promise.all([
      Expense.find(filter)
        .sort({ paidOn: -1, createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Expense.countDocuments(filter),
      expenseTotals(scope, rangeStart, rangeEnd, category),
      expenseTotals(scope, priorStart, rangeStart, category),
    ]);

    return { rows, total, totals, previous };
  });

  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (category) baseQuery.set("category", category);
  const baseHref = baseQuery.toString()
    ? `/expenses?${baseQuery.toString()}`
    : "/expenses";

  const filtered = Boolean(category || from !== monthStart || to !== today);

  const change =
    previous.total > 0
      ? Math.round(((totals.total - previous.total) / previous.total) * 100)
      : null;

  const biggest = totals.byCategory[0];
  const largestShare =
    biggest && totals.total > 0
      ? Math.round((biggest.amount / totals.total) * 100)
      : 0;

  const editing = params.edit
    ? rows.find((row) => String(row._id) === params.edit)
    : undefined;

  /**
   * The link on a category row.
   *
   * Clicking the category you are already filtered to clears it, so the row
   * works as a toggle rather than as a dead end you have to use Reset to leave.
   * Built with URLSearchParams rather than by editing the query string, which
   * leaves a dangling separator behind.
   */
  const categoryHref = (next: ExpenseCategory) => {
    const query = new URLSearchParams(baseQuery);
    if (category === next) query.delete("category");
    else query.set("category", next);
    const encoded = query.toString();
    return encoded ? `/expenses?${encoded}` : "/expenses";
  };

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={`Running costs that are not stock, ${from} to ${to}.`}
        actions={
          <>
            <Link href="/reports" className="btn-secondary">
              Reports
            </Link>
            <Link
              href={`/expenses?new=1${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
              className="btn-primary"
            >
              Record an expense
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Spent"
          value={money(totals.total)}
          hint={`${integer(totals.count)} entr${totals.count === 1 ? "y" : "ies"}`}
          tone="brand"
        />
        <StatCard
          label="Previous period"
          value={money(previous.total)}
          hint={
            change === null
              ? "Nothing recorded before this"
              : `${change > 0 ? "+" : ""}${change}% this period`
          }
          tone={change !== null && change > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Largest category"
          value={biggest ? EXPENSE_CATEGORY_LABELS[biggest.category] : "—"}
          hint={biggest ? `${money(biggest.amount)} · ${largestShare}%` : "Nothing yet"}
        />
        <StatCard
          label="Categories used"
          value={integer(totals.byCategory.length)}
          hint={`of ${EXPENSE_CATEGORIES.length}`}
        />
      </div>

      <Card className="mt-4 mb-4 p-3.5 sm:p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <label htmlFor="from" className="label">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={from}
              className="input tnum"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="to" className="label">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={to}
              className="input tnum"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="category" className="label">
              Category
            </label>
            <select
              id="category"
              name="category"
              defaultValue={category ?? ""}
              className="input"
            >
              <option value="">All categories</option>
              {EXPENSE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {EXPENSE_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary flex-1">
              Apply
            </button>
            {filtered ? (
              <Link href="/expenses" className="btn-secondary">
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {/*
        The split by category is the reason this screen exists. One number for
        "costs" tells an owner nothing they can act on; seeing that salaries are
        two thirds of it tells them where to look. The bar is drawn against the
        largest line rather than the total, so the small categories are still
        visible instead of collapsing to a sliver.
      */}
      {totals.byCategory.length > 1 ? (
        <Card className="mb-4 p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">
            Where it went
          </h2>
          <ul className="space-y-2">
            {totals.byCategory.map((row) => {
              const share =
                totals.total > 0 ? (row.amount / totals.total) * 100 : 0;
              const width = biggest ? (row.amount / biggest.amount) * 100 : 0;
              const active = category === row.category;

              return (
                <li key={row.category}>
                  <Link
                    href={categoryHref(row.category)}
                    className={cx(
                      "block rounded-lg px-2 py-1.5 transition-colors",
                      active ? "bg-brand-50" : "hover:bg-slate-50",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span
                        className={cx(
                          "truncate",
                          active ? "font-medium text-brand-800" : "text-slate-700",
                        )}
                      >
                        {EXPENSE_CATEGORY_LABELS[row.category]}
                      </span>
                      <span className="tnum shrink-0 font-medium text-slate-900">
                        {money(row.amount)}
                        <span className="ml-1.5 text-xs font-normal text-slate-400">
                          {Math.round(share)}%
                        </span>
                      </span>
                    </div>
                    <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <span
                        className={cx(
                          "block h-full rounded-full",
                          active ? "bg-brand-600" : "bg-brand-400",
                        )}
                        style={{ width: `${Math.max(2, width)}%` }}
                      />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "Nothing matches these filters" : "No expenses recorded"}
            description={
              filtered
                ? "Try widening the dates, or clearing the category."
                : "Rent, wages and utilities go here. Until they do, the reports show gross margin rather than net profit."
            }
            action={
              filtered ? (
                <Link href="/expenses" className="btn-secondary">
                  Reset filters
                </Link>
              ) : (
                <Link href="/expenses?new=1" className="btn-primary">
                  Record an expense
                </Link>
              )
            }
          />
        ) : (
          <>
            <TableWrap minWidth="42rem" pinFirst pinLast>
              <thead>
                <tr>
                  <th className="th">Paid on</th>
                  <th className="th">What for</th>
                  <th className="th">Category</th>
                  <th className="th">Paid to</th>
                  <th className="th">Method</th>
                  <th className="th text-right">Amount</th>
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const id = String(row._id);
                  return (
                    <tr key={id} className="hover:bg-slate-50">
                      <td className="td tnum whitespace-nowrap text-slate-600">
                        {formatDate(row.paidOn as unknown as Date)}
                      </td>
                      <td className="td">
                        <span className="block max-w-[16rem] truncate font-medium text-slate-900">
                          {row.description}
                        </span>
                        {row.reference ? (
                          <span className="block font-mono text-[11px] text-slate-400">
                            {row.reference}
                          </span>
                        ) : null}
                      </td>
                      <td className="td">
                        <Badge tone="slate">
                          {EXPENSE_CATEGORY_LABELS[row.category as ExpenseCategory]}
                        </Badge>
                      </td>
                      <td className="td max-w-[12rem] truncate text-slate-600">
                        {row.payee || "—"}
                      </td>
                      <td className="td text-slate-600">
                        {EXPENSE_METHOD_LABELS[row.method as ExpenseMethod] ??
                          row.method}
                      </td>
                      <td className="td tnum text-right font-semibold text-slate-900">
                        {money(row.amount)}
                      </td>
                      <td className="td col-actions">
                        <ActionBar>
                          <ActionIcon
                            label="Edit"
                            icon="edit"
                            tone="primary"
                            href={`/expenses?edit=${id}${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
                          />
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
              baseHref={baseHref}
            />
          </>
        )}
      </Card>

      {params.new === "1" || editing ? (
        <ExpenseFormPanel
          returnHref={baseHref}
          expense={
            editing
              ? {
                  id: String(editing._id),
                  category: editing.category as ExpenseCategory,
                  description: editing.description,
                  payee: editing.payee ?? "",
                  amount: editing.amount,
                  method: editing.method as ExpenseMethod,
                  paidOn: dateInputValue(editing.paidOn as unknown as Date),
                  reference: editing.reference ?? "",
                  note: editing.note ?? "",
                }
              : null
          }
        />
      ) : null}
    </>
  );
}
