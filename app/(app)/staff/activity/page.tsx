import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import {
  addDays,
  dateRangeFromStrings,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { formatDateTime, initials, integer } from "@/lib/format";
import { pharmacyFilter } from "@/lib/tenant";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_TONE,
  readActivity,
  type ActivityKind,
} from "@/lib/activity-log";
import { User } from "@/models/User";
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
import { ModuleTabs } from "@/components/ModuleScaffold";
import { STAFF_TABS } from "../tabs";

export const metadata: Metadata = { title: "Activity history" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Who did what, across the shop.
 *
 * Read back from the records themselves rather than from an audit-log table -
 * a bill already carries who raised it, a void who voided it, a stock movement
 * who moved it. See lib/activity-log.ts for why that is the honest way round.
 *
 * Defaults to the last seven days. This screen is opened to answer "what
 * happened on Tuesday" or "what has Sunita been doing", neither of which is a
 * question about the last four hours.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    user?: string;
    kind?: string;
    page?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("user:manage");
  const params = await searchParams;

  const today = toDateInputValue();
  const todayDate = parseLocalDate(today);
  const weekAgo = todayDate ? toDateInputValue(addDays(todayDate, -6)) : today;

  const askedFrom = (params.from ?? weekAgo).trim();
  const askedTo = (params.to ?? today).trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const page = Math.max(1, Number(params.page) || 1);
  const kind = ACTIVITY_KINDS.includes(params.kind as ActivityKind)
    ? (params.kind as ActivityKind)
    : null;

  const { activity, staff } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const { start, end } = dateRangeFromStrings(from, to);

    const [activity, staff] = await Promise.all([
      readActivity(user, {
        scope,
        start: start ?? new Date(0),
        end: end ?? new Date(),
        userId: params.user || null,
        kinds: kind ? [kind] : undefined,
      }),
      User.find(pharmacyFilter(user)).select("name lastLoginAt").sort({ name: 1 }).lean(),
    ]);

    return { activity, staff };
  });

  const shown = activity.entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (params.user) baseQuery.set("user", params.user);
  if (kind) baseQuery.set("kind", kind);
  const baseHref = baseQuery.toString()
    ? `/staff/activity?${baseQuery.toString()}`
    : "/staff/activity";

  const filtered = Boolean(
    params.user || kind || from !== weekAgo || to !== today,
  );

  const selected = params.user
    ? staff.find((row) => String(row._id) === params.user)
    : undefined;

  const kindHref = (next: ActivityKind) => {
    const query = new URLSearchParams(baseQuery);
    query.set("kind", next);
    return `/staff/activity?${query.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Activity history"
        subtitle={
          selected
            ? `What ${selected.name} did between ${from} and ${to}.`
            : `What this pharmacy's people did between ${from} and ${to}.`
        }
        actions={
          filtered ? (
            <Link href="/staff/activity" className="btn-secondary">
              Reset
            </Link>
          ) : null
        }
      />

      <ModuleTabs tabs={STAFF_TABS} active="/staff/activity" />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Actions"
          value={integer(activity.entries.length)}
          hint={`${from} to ${to}`}
          tone="brand"
        />
        <StatCard
          label="People active"
          value={integer(activity.byUser.length)}
          hint={
            activity.byUser.length > 0
              ? `Busiest: ${activity.byUser[0]!.userName}`
              : "Nobody in this range"
          }
        />
        <StatCard label="Accounts" value={integer(staff.length)} />
        <StatCard
          label="Never signed in"
          value={integer(staff.filter((row) => !row.lastLoginAt).length)}
          hint="Issued but unused"
        />
      </div>

      <Card className="mb-4 p-3.5 sm:p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="min-w-0">
            <label htmlFor="from" className="label">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={from}
              max={today}
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
              max={today}
              className="input tnum"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="user" className="label">
              Person
            </label>
            <select
              id="user"
              name="user"
              defaultValue={params.user ?? ""}
              className="input"
            >
              <option value="">Everyone</option>
              {staff.map((row) => (
                <option key={String(row._id)} value={String(row._id)}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0">
            <label htmlFor="kind" className="label">
              Activity
            </label>
            <select id="kind" name="kind" defaultValue={kind ?? ""} className="input">
              <option value="">Everything</option>
              {ACTIVITY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {ACTIVITY_KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full">
              Apply
            </button>
          </div>
        </form>
      </Card>

      {/*
        Who was busy, and on what. Clicking either narrows the list - which is
        the actual question behind opening this screen, rather than scrolling
        four hundred rows looking for one person's name.
      */}
      {activity.byUser.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {activity.byUser.map((row) => {
            const query = new URLSearchParams(baseQuery);
            if (row.userId) query.set("user", row.userId);
            const active = params.user === row.userId;

            return (
              <Link
                key={row.userId ?? row.userName}
                href={`/staff/activity?${query.toString()}`}
                className={cx(
                  "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                  active
                    ? "border-brand-300 bg-brand-50 text-brand-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-800">
                  {initials(row.userName)}
                </span>
                <span className="font-medium">{row.userName}</span>
                <span className="tnum font-semibold text-slate-900">
                  {integer(row.count)}
                </span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {activity.byKind.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {activity.byKind.map((row) => (
            <Link
              key={row.kind}
              href={kindHref(row.kind)}
              className={cx(
                "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                kind === row.kind
                  ? "border-brand-300 bg-brand-50 text-brand-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {ACTIVITY_KIND_LABELS[row.kind]}
              <span className="tnum ml-2 font-semibold text-slate-900">
                {integer(row.count)}
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <EmptyState
            title="Nothing happened in this range"
            description={
              filtered
                ? "Try widening the dates, or clearing the person and activity filters."
                : "Actions appear here as staff bill, receive stock and take payments."
            }
            action={
              filtered ? (
                <Link href="/staff/activity" className="btn-secondary">
                  Reset filters
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">Who</th>
                  <th className="th">Did what</th>
                  <th className="th hidden lg:table-cell">To</th>
                  <th className="th hidden xl:table-cell">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50">
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDateTime(entry.at)}
                    </td>

                    <td className="td">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-800">
                          {initials(entry.userName)}
                        </span>
                        <span className="truncate font-medium text-slate-900">
                          {entry.userName}
                        </span>
                      </div>
                    </td>

                    <td className="td">
                      <Badge tone={ACTIVITY_TONE[entry.kind]}>{entry.action}</Badge>
                      {/* The columns hidden on a phone, folded in underneath. */}
                      <span className="mt-0.5 block text-[11px] text-slate-400 lg:hidden">
                        {entry.subject}
                      </span>
                    </td>

                    <td className="td hidden lg:table-cell">
                      {entry.href ? (
                        <Link
                          href={entry.href}
                          className="font-mono text-xs text-brand-700 hover:underline"
                        >
                          {entry.subject}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-slate-600">
                          {entry.subject}
                        </span>
                      )}
                    </td>

                    <td className="td hidden max-w-[18rem] truncate text-slate-600 xl:table-cell">
                      {entry.detail || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            <Pagination
              page={page}
              totalPages={Math.max(1, Math.ceil(activity.entries.length / PAGE_SIZE))}
              total={activity.entries.length}
              baseHref={baseHref}
            />
          </>
        )}
      </Card>

      {/*
        What this screen genuinely cannot show, stated rather than implied by
        its absence. Everything above is read back off a document somebody's
        action produced; anything that produces no document leaves no trace.
      */}
      <p className="mt-4 text-xs text-slate-500">
        Read back from the records themselves - every bill, purchase, stock
        movement and prescription stamps who did it. Actions that leave no
        document behind, such as viewing a report or a failed sign-in attempt,
        are not recorded anywhere and so cannot be listed here.
      </p>
    </>
  );
}
