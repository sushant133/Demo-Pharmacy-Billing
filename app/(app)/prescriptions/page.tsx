import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { branchFilter, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { dateRangeFromStrings, toDateInputValue } from "@/lib/dates";
import { formatDate, integer } from "@/lib/format";
import {
  PRESCRIPTION_STATUSES,
  PRESCRIPTION_STATUS_LABELS,
  isPrescriptionStatus,
  prescriptionStatus,
  prescriptionStatusFilter,
} from "@/lib/prescription-status";
import { can } from "@/lib/roles";
import { Prescription } from "@/models/Prescription";
import { PrescriptionFormPanel } from "@/components/prescriptions/PrescriptionFormPanel";
import {
  Badge,
  Card,
  EmptyState,
  Pagination,
  StatCard,
  TableWrap,
  cx,
} from "@/components/ui";

export const metadata: Metadata = { title: "Prescriptions" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Prescriptions filed at the counter.
 *
 * A sale records what left the shelf; this records what was asked for, by whom
 * and for whom, and how much of it is still owed. The two are deliberately
 * separate: one script is filled across several visits, a bill covers items
 * from no script at all, and collapsing them would make both unreadable.
 *
 * A server component with a plain GET form for filtering, like /sales: the URL
 * is the state, so a filtered view is a shareable, bookmarkable link. The new
 * prescription panel is the only client island, opened by ?new=1 so the form
 * survives a refresh.
 */
export default async function PrescriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: string;
    new?: string;
    branch?: string;
  }>;
}) {
  const user = await requirePagePermission("sale:read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page) || 1);
  const search = (params.q ?? "").trim();
  const status = isPrescriptionStatus(params.status) ? params.status : null;
  const canFile = can(user.role, "sale:create");

  // No default range. A script is looked up months after it was written, and a
  // list that opened on "today" would be empty almost every time it is opened.
  const askedFrom = (params.from ?? "").trim();
  const askedTo = (params.to ?? "").trim();
  const reversed = Boolean(askedFrom && askedTo && askedTo < askedFrom);
  const from = reversed ? askedTo : askedFrom;
  const to = reversed ? askedFrom : askedTo;

  const { rows, total, counts } = await withDbRead(async () => {
    const scope = await resolveViewScope(user, params.branch);
    const base: Record<string, unknown> = { ...branchFilter(scope) };

    const { start, end } = dateRangeFromStrings(from, to);
    if (start || end) {
      const range: Record<string, Date> = {};
      if (start) range.$gte = start;
      if (end) range.$lt = end;
      base.issuedOn = range;
    }

    const filter: Record<string, unknown> = { ...base };
    const clauses: Record<string, unknown>[] = [];

    // Drawn from the same rule that draws the badges, so the dropdown cannot
    // return a row the badge disagrees with.
    if (status) clauses.push(prescriptionStatusFilter(status));

    if (search) {
      const pattern = new RegExp(escapeRegExp(search), "i");
      clauses.push({
        $or: [
          { rxNo: pattern },
          { patientName: pattern },
          { patientPhone: pattern },
          { doctorName: pattern },
          { "items.medicineName": pattern },
        ],
      });
    }

    if (clauses.length > 0) filter.$and = clauses;

    const [rows, total, outstandingCount, expiredCount] = await Promise.all([
      Prescription.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Prescription.countDocuments(filter),
      // Counted over the whole register rather than the filtered view: these
      // two tiles are the reason somebody opens this screen, and a figure that
      // changed with the search would be answering a different question.
      Prescription.countDocuments({
        ...branchFilter(scope),
        ...prescriptionStatusFilter("partial"),
      }),
      Prescription.countDocuments({
        ...branchFilter(scope),
        ...prescriptionStatusFilter("expired"),
      }),
    ]);

    return {
      rows,
      total,
      counts: { outstanding: outstandingCount, expired: expiredCount },
    };
  });

  const baseQuery = new URLSearchParams();
  if (search) baseQuery.set("q", search);
  if (status) baseQuery.set("status", status);
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  const filtered = Boolean(search || status || from || to);

  const statusHref = (next: string) => {
    const query = new URLSearchParams(baseQuery);
    query.set("status", next);
    return `/prescriptions?${query.toString()}`;
  };

  return (
    <>
      <header className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm shadow-brand-900/20 sm:h-14 sm:w-14"
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
                d="M6 3h6l6 6v12H6V3zm6 0v6h6M9 13h6m-6 4h4"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              Prescriptions
            </h1>
            <p className="mt-0.5 text-sm text-pretty text-slate-500">
              What was prescribed, and how much of it is still owed.
            </p>
          </div>
        </div>

        {canFile ? (
          <Link
            href={`/prescriptions?new=1${baseQuery.toString() ? "&" + baseQuery.toString() : ""}`}
            className="btn-primary shrink-0"
          >
            <svg
              className="h-4.5 w-4.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.9}
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M12 8.5v7M8.5 12h7" />
            </svg>
            File a prescription
          </Link>
        ) : null}
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Prescriptions"
          value={integer(total)}
          hint={filtered ? "Matching these filters" : "All time"}
          tone="brand"
        />
        <StatCard
          label="Part dispensed"
          value={integer(counts.outstanding)}
          hint="Still owed to a patient"
          tone={counts.outstanding > 0 ? "warning" : "default"}
          href={counts.outstanding > 0 ? statusHref("partial") : undefined}
        />
        <StatCard
          label="Expired"
          value={integer(counts.expired)}
          hint="Lapsed with something left on them"
          tone={counts.expired > 0 ? "warning" : "default"}
          href={counts.expired > 0 ? statusHref("expired") : undefined}
        />
        <StatCard label="On this page" value={integer(rows.length)} hint="Newest first" />
      </div>

      <Card className="mb-4 p-3.5 sm:p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="q" className="label">
              Search
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search}
              placeholder="Rx no, patient, phone, doctor or medicine"
              className="input"
            />
          </div>

          <div className="min-w-0">
            <label htmlFor="status" className="label">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={status ?? ""}
              className="input"
            >
              <option value="">All statuses</option>
              {PRESCRIPTION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PRESCRIPTION_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0">
            <label htmlFor="from" className="label">
              Written from
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={from}
              max={toDateInputValue()}
              className="input tnum"
            />
          </div>

          <div className="flex min-w-0 flex-col">
            <label htmlFor="to" className="label">
              To
            </label>
            <div className="flex gap-2">
              <input
                id="to"
                name="to"
                type="date"
                defaultValue={to}
                max={toDateInputValue()}
                className="input tnum"
              />
            </div>
          </div>

          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
            <button type="submit" className="btn-primary">
              Apply
            </button>
            {filtered ? (
              <Link href="/prescriptions" className="btn-secondary">
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={
              filtered ? "No prescription matches these filters" : "No prescriptions filed"
            }
            description={
              filtered
                ? "Try a different status, or widen the dates."
                : "File the script a customer brings in and it is tracked here until every line has been handed over."
            }
            action={
              filtered ? (
                <Link href="/prescriptions" className="btn-secondary">
                  Reset filters
                </Link>
              ) : canFile ? (
                <Link href="/prescriptions?new=1" className="btn-primary">
                  File a prescription
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap minWidth="42rem" pinFirst>
              <thead>
                <tr>
                  <th className="th">Rx no</th>
                  <th className="th">Patient</th>
                  <th className="th">Prescriber</th>
                  <th className="th">Written</th>
                  <th className="th">Valid until</th>
                  <th className="th text-right">Dispensed</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const id = String(row._id);
                  const state = prescriptionStatus(row);
                  const lines = row.items.length;

                  return (
                    <tr key={id} className="hover:bg-slate-50">
                      <td className="td">
                        <Link
                          href={`/prescriptions/${id}`}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {row.rxNo}
                        </Link>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {lines} medicine{lines === 1 ? "" : "s"}
                        </span>
                      </td>

                      <td className="td">
                        <span className="block max-w-[12rem] truncate font-medium text-slate-900">
                          {row.patientName}
                        </span>
                        {row.patientPhone ? (
                          <span className="tnum block text-[11px] text-slate-400">
                            {row.patientPhone}
                          </span>
                        ) : null}
                      </td>

                      <td className="td">
                        <span className="block max-w-[12rem] truncate text-slate-700">
                          {row.doctorName}
                        </span>
                        {row.hospital ? (
                          <span className="block max-w-[12rem] truncate text-[11px] text-slate-400">
                            {row.hospital}
                          </span>
                        ) : null}
                      </td>

                      <td className="td tnum whitespace-nowrap text-slate-600">
                        {formatDate(row.issuedOn as unknown as Date)}
                      </td>

                      <td className="td tnum whitespace-nowrap text-slate-600">
                        {row.validUntil
                          ? formatDate(row.validUntil as unknown as Date)
                          : "—"}
                      </td>

                      <td className="td text-right">
                        <span className="tnum font-medium text-slate-900">
                          {integer(row.dispensedUnits)} / {integer(row.prescribedUnits)}
                        </span>
                        {/*
                          A bar rather than a second number: "18 of 30" is the
                          fact, and how far along that is should be readable
                          without doing the division.
                        */}
                        <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-slate-200">
                          <span
                            className={cx(
                              "block h-full rounded-full",
                              state.status === "cancelled"
                                ? "bg-slate-400"
                                : state.outstanding === 0
                                  ? "bg-emerald-500"
                                  : "bg-amber-500",
                            )}
                            style={{
                              width: `${
                                row.prescribedUnits > 0
                                  ? Math.min(
                                      100,
                                      Math.round(
                                        (row.dispensedUnits / row.prescribedUnits) * 100,
                                      ),
                                    )
                                  : 0
                              }%`,
                            }}
                          />
                        </span>
                      </td>

                      <td className="td">
                        <Badge tone={state.tone}>{state.label}</Badge>
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
                  ? `/prescriptions?${baseQuery.toString()}`
                  : "/prescriptions"
              }
            />
          </>
        )}
      </Card>

      {canFile && params.new === "1" ? (
        <PrescriptionFormPanel
          returnHref={
            baseQuery.toString()
              ? `/prescriptions?${baseQuery.toString()}`
              : "/prescriptions"
          }
        />
      ) : null}
    </>
  );
}

/** The search box takes free text; it must not be able to inject a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
