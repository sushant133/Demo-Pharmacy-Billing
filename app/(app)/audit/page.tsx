import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import {
  addDays,
  dateRangeFromStrings,
  parseLocalDate,
  toDateInputValue,
} from "@/lib/dates";
import { formatDateTime, integer } from "@/lib/format";
import { roleName } from "@/lib/roles";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_TONE,
  AUDIT_ENTITY_LABELS,
  auditActors,
  describeAuditValue,
  isAuditAction,
  readAuditLog,
} from "@/lib/audit-view";
import { AUDIT_ACTIONS } from "@/models/AuditLog";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  TableWrap,
} from "@/components/ui";

export const metadata: Metadata = { title: "Audit trail" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** Changes listed under one entry before the rest are summarised. */
const CHANGES_SHOWN = 6;

/**
 * The audit trail: every change to every record, every sign-in and sign-out,
 * with who did it and the values before and after.
 *
 * Read-only by construction - there is nothing on this screen, or anywhere in
 * the app, that edits or removes an entry. Open to the owner and to an
 * auditor login; see lib/roles.ts.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    user?: string;
    action?: string;
    entity?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const user = await requirePagePermission("audit:read");
  const params = await searchParams;

  const today = toDateInputValue();
  const todayDate = parseLocalDate(today);
  const weekAgo = todayDate ? toDateInputValue(addDays(todayDate, -6)) : today;
  const from = (params.from ?? weekAgo).trim();
  const to = (params.to ?? today).trim();
  const action = isAuditAction(params.action) ? params.action : null;
  const entity = params.entity && AUDIT_ENTITY_LABELS[params.entity] ? params.entity : null;
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const { start, end } = dateRangeFromStrings(from, to);
  const query = {
    start: start ?? new Date(0),
    end: end ?? new Date(),
    actorId: params.user || null,
    action,
    entity,
    search: search || null,
  };

  const [{ rows, total }, actors] = await withDbRead(() =>
    Promise.all([
      readAuditLog(user, query, { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
      auditActors(user),
    ]),
  );

  const baseQuery = new URLSearchParams();
  if (from) baseQuery.set("from", from);
  if (to) baseQuery.set("to", to);
  if (params.user) baseQuery.set("user", params.user);
  if (action) baseQuery.set("action", action);
  if (entity) baseQuery.set("entity", entity);
  if (search) baseQuery.set("q", search);
  const baseHref = baseQuery.toString() ? `/audit?${baseQuery.toString()}` : "/audit";
  const exportHref = (format: string) => {
    const q = new URLSearchParams(baseQuery);
    q.set("format", format);
    return `/api/audit/export?${q.toString()}`;
  };

  const tampered = rows.filter((row) => !row.verified).length;

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle={`Every change, sign-in and sign-out between ${from} and ${to}. Entries cannot be edited or removed.`}
        actions={
          <div className="flex gap-1">
            {(["pdf", "xlsx", "csv"] as const).map((format) => (
              <a
                key={format}
                href={exportHref(format)}
                className="btn-secondary uppercase"
              >
                {format === "xlsx" ? "Excel" : format}
              </a>
            ))}
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Entries" value={integer(total)} hint={`${from} to ${to}`} tone="brand" />
        <StatCard label="People" value={integer(actors.length)} hint="Appear anywhere in the trail" />
        <StatCard
          label="Failed verification"
          value={integer(tampered)}
          hint={tampered ? "On this page - altered after writing" : "On this page"}
        />
      </div>

      <Card className="mb-4 p-3.5 sm:p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
          <div className="min-w-0">
            <label htmlFor="from" className="label">From</label>
            <input id="from" name="from" type="date" defaultValue={from} max={today} className="input tnum" />
          </div>
          <div className="min-w-0">
            <label htmlFor="to" className="label">To</label>
            <input id="to" name="to" type="date" defaultValue={to} max={today} className="input tnum" />
          </div>
          <div className="min-w-0">
            <label htmlFor="user" className="label">Person</label>
            <select id="user" name="user" defaultValue={params.user ?? ""} className="input">
              <option value="">Everyone</option>
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id}>{actor.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="action" className="label">Action</label>
            <select id="action" name="action" defaultValue={action ?? ""} className="input">
              <option value="">Any</option>
              {AUDIT_ACTIONS.map((value) => (
                <option key={value} value={value}>{AUDIT_ACTION_LABELS[value]}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="entity" className="label">Record type</label>
            <select id="entity" name="entity" defaultValue={entity ?? ""} className="input">
              <option value="">Any</option>
              {Object.entries(AUDIT_ENTITY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="q" className="label">Bill no / name</label>
            <input id="q" name="q" defaultValue={search} placeholder="INV-2083…" className="input" />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full">Apply</button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No entries in this range"
            description="Changes appear here as soon as anyone saves anything."
            action={
              <Link href="/audit" className="btn-secondary">
                Reset filters
              </Link>
            }
          />
        ) : (
          <>
            <TableWrap minWidth="52rem" pinFirst>
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">Who</th>
                  <th className="th">Action</th>
                  <th className="th">Record</th>
                  <th className="th">Old → new</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-slate-50">
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDateTime(row.at)}
                      {!row.verified ? (
                        <span className="mt-1 block">
                          <Badge tone="rose">Altered</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="td">
                      <span className="font-medium text-slate-900">{row.actorName}</span>
                      <span className="block text-xs text-slate-500">
                        {roleName(row.actorRole) || "—"}
                        {row.impersonatorName ? ` · via ${row.impersonatorName}` : ""}
                      </span>
                      {row.ip ? (
                        <span className="block font-mono text-[11px] text-slate-400">{row.ip}</span>
                      ) : null}
                    </td>
                    <td className="td">
                      <Badge tone={AUDIT_ACTION_TONE[row.action]}>
                        {AUDIT_ACTION_LABELS[row.action]}
                      </Badge>
                    </td>
                    <td className="td">
                      <span className="text-xs text-slate-500">
                        {AUDIT_ENTITY_LABELS[row.entity] ?? row.entity}
                      </span>
                      <span className="block font-mono text-xs text-slate-800">
                        {row.label || row.entityId || row.note || "—"}
                      </span>
                    </td>
                    <td className="td text-xs text-slate-600">
                      {row.action === "update" ? (
                        <ul className="space-y-0.5">
                          {row.changes.slice(0, CHANGES_SHOWN).map((change) => (
                            <li key={change.path}>
                              <span className="font-medium text-slate-800">{change.path}</span>
                              {": "}
                              <span className="text-rose-700 line-through decoration-rose-300">
                                {describeAuditValue(change.before)}
                              </span>
                              {" → "}
                              <span className="text-emerald-700">
                                {describeAuditValue(change.after)}
                              </span>
                            </li>
                          ))}
                          {row.changes.length > CHANGES_SHOWN ? (
                            <li className="text-slate-400">
                              +{row.changes.length - CHANGES_SHOWN} more fields
                            </li>
                          ) : null}
                        </ul>
                      ) : row.action === "create" ? (
                        `${row.changes.length} fields set`
                      ) : row.action === "delete" ? (
                        "Record removed - the export lists the values it held"
                      ) : (
                        row.note || "—"
                      )}
                    </td>
                  </tr>
                ))}
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

      <p className="mt-4 text-xs text-slate-500">
        Written in the same database transaction as each change, and signed
        with a key the database does not hold. &quot;Altered&quot; marks an entry
        whose stored contents no longer match its signature.
      </p>
    </>
  );
}
