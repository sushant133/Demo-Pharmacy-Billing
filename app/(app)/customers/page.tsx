import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { outstandingByCustomer } from "@/lib/customer-dues";
import { withDbRead } from "@/lib/db";
import { formatDate, integer, money } from "@/lib/format";
import { can } from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { Customer } from "@/models/Customer";
import {
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";
import { ActionBar, ActionIcon } from "@/components/action-icons";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Customer / patient register.
 *
 * These records are created at the till: naming a customer on a bill is what
 * files them, which is why there is no "add customer" button here. This screen
 * is the read-back - who has been served, how to reach them, and the PAN a
 * business customer needs on their invoice.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePagePermission("customer:read");
  const params = await searchParams;
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const { rows, total, withPhone, dues } = await withDbRead(async () => {
    const filter: Record<string, unknown> = { ...pharmacyFilter(user) };
    if (search) {
      const rx = new RegExp(escapeRegExp(search), "i");
      filter.$or = [{ name: rx }, { phone: rx }, { panNo: rx }];
    }

    const [rows, total, withPhone] = await Promise.all([
      Customer.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Customer.countDocuments(filter),
      Customer.countDocuments({ ...pharmacyFilter(user), phone: { $ne: "" } }),
    ]);

    // What each of the customers on *this page* still owes - one aggregation
    // for the page rather than one per row, and never for the whole register,
    // which on a shop with ten thousand names would be a query nobody asked
    // for to fill a column showing twenty-five numbers.
    const dues = await outstandingByCustomer(
      user,
      rows.map((row) => String(row._id)),
    );

    return { rows, total, withPhone, dues };
  });

  const canSeeMoney = can(user.role, "report:financial");
  const owing = rows.filter((row) => (dues.get(String(row._id)) ?? 0) > 0);
  const owingCount = owing.length;
  const pageDues = owing.reduce(
    (sum, row) => sum + (dues.get(String(row._id)) ?? 0),
    0,
  );

  // Every filter except `page`, so paging never drops the search.
  const baseQuery = new URLSearchParams();
  if (search) baseQuery.set("q", search);

  return (
    <>
      <PageHeader
        title="Customers / patients"
        subtitle="Filed automatically when a bill is raised in their name."
        actions={
          <Link href="/billing" className="btn-primary">
            New sale
          </Link>
        }
      />

      <div
        className={cx(
          "grid grid-cols-2 gap-3",
          canSeeMoney ? "lg:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        <StatCard label="On file" value={integer(total)} />
        <StatCard
          label="Reachable"
          value={integer(withPhone)}
          hint="Has a phone number"
        />
        {/*
          Owing, for this page only - the column below is what it totals, and a
          tile that silently summed the whole register would disagree with the
          rows underneath it every time somebody paged or searched.
        */}
        {canSeeMoney ? (
          <StatCard
            label="Owing, on this page"
            value={money(pageDues)}
            hint={`${integer(owingCount)} of ${integer(rows.length)} shown`}
            tone={pageDues > 0 ? "warning" : "default"}
          />
        ) : null}
        <StatCard
          label="Shown here"
          value={integer(rows.length)}
          hint={search ? `Matching “${search}”` : "Most recently billed first"}
        />
      </div>

      <Card className="mt-4 mb-4 p-4">
        <form className="flex flex-wrap items-end gap-2" action="/customers">
          <div className="min-w-0 flex-1">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Name, phone or PAN"
              className="input"
            />
          </div>
          <button type="submit" className="btn-primary">
            Search
          </button>
          {search ? (
            <Link href="/customers" className="btn-secondary">
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={search ? "No customer matches that" : "No customers yet"}
            description={
              search
                ? "Try a phone number, or part of the name."
                : "Name a customer on a bill and they appear here."
            }
          />
        ) : (
          <>
            <TableWrap minWidth="42rem" pinFirst pinLast>
              <thead>
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Phone</th>
                  <th className="th">PAN</th>
                  <th className="th">Address</th>
                  {canSeeMoney ? (
                    <th className="th text-right">Outstanding</th>
                  ) : null}
                  <th className="th text-right">Last billed</th>
                  <th className="th text-right col-actions">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const id = String(row._id);
                  const due = dues.get(id) ?? 0;
                  // The invoices for this person, which is the screen anybody
                  // clicking a name is on their way to. Searched by phone when
                  // there is one: two patients share a name far more often
                  // than they share a handset.
                  const invoicesHref = `/invoices?q=${encodeURIComponent(
                    row.phone || row.name,
                  )}`;

                  return (
                    <tr key={id} className="hover:bg-slate-50">
                      <td className="td font-medium text-slate-900">
                        <Link
                          href={invoicesHref}
                          className="hover:text-brand-700"
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td className="td tnum text-slate-600">
                        {row.phone || "—"}
                      </td>
                      <td className="td tnum text-slate-600">
                        {row.panNo || "—"}
                      </td>
                      <td className="td max-w-[18rem] truncate text-slate-500">
                        {row.address || "—"}
                      </td>
                      {canSeeMoney ? (
                        <td className="td text-right">
                          {due > 0 ? (
                            <Link
                              href={`${invoicesHref}&status=pending`}
                              className="tnum font-semibold text-amber-700 hover:underline"
                            >
                              {money(due)}
                            </Link>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      ) : null}
                      <td className="td text-right text-slate-500">
                        {formatDate(row.updatedAt as unknown as Date)}
                      </td>
                      <td className="td col-actions">
                        <ActionBar>
                          <ActionIcon
                            label="View invoices"
                            icon="invoices"
                            tone="primary"
                            href={invoicesHref}
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
              baseHref={
                baseQuery.toString()
                  ? `/customers?${baseQuery.toString()}`
                  : "/customers"
              }
            />
          </>
        )}
      </Card>
    </>
  );
}

/** The search box takes free text; it must not be able to inject a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
