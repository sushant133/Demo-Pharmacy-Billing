import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { verifyAuditEntry } from "@/lib/audit";
import { bsDateOf } from "@/lib/export/ird-reports";
import { formatTime } from "@/lib/format";
import { roleName } from "@/lib/roles";
import { AUDIT_ACTIONS, AuditLog, type AuditAction } from "@/models/AuditLog";
import type { ReportDataset } from "@/lib/export/dataset";
import type { SessionUser } from "@/lib/session";

/**
 * Reading the audit trail back, for the Audit screen and its export.
 *
 * Always scoped to the signed-in user's pharmacy: one shop's owner, or the
 * auditor it issued, sees that shop's trail and nothing else.
 */

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: "Created",
  update: "Changed",
  delete: "Deleted",
  login: "Signed in",
  "login-failed": "Sign-in refused",
  logout: "Signed out",
};

export const AUDIT_ACTION_TONE: Record<AuditAction, "slate" | "brand" | "green" | "amber" | "rose"> = {
  create: "green",
  update: "brand",
  delete: "rose",
  login: "slate",
  "login-failed": "amber",
  logout: "slate",
};

/** What each collection is called on screen. */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Sale: "Bill",
  Purchase: "Purchase",
  Batch: "Stock lot",
  Medicine: "Medicine",
  Customer: "Customer",
  Supplier: "Supplier",
  SupplierPayment: "Supplier payment",
  StockMovement: "Stock movement",
  Prescription: "Prescription",
  Expense: "Expense",
  Branch: "Branch",
  Setting: "Settings",
  Pharmacy: "Pharmacy profile",
  User: "Staff account",
};

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditQuery {
  start: Date;
  end: Date;
  actorId?: string | null;
  action?: AuditAction | null;
  entity?: string | null;
  /** Matches the record's label: a bill number, a medicine name. */
  search?: string | null;
}

export interface AuditRow {
  id: string;
  at: Date;
  action: AuditAction;
  entity: string;
  entityId: string;
  label: string;
  changes: Array<{ path: string; before: unknown; after: unknown }>;
  actorId: string;
  actorName: string;
  actorRole: string;
  impersonatorName: string;
  path: string;
  ip: string;
  note: string;
  /** False when the stored entry no longer matches its signature. */
  verified: boolean;
}

function filterFor(user: SessionUser, query: AuditQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    pharmacyId: Types.ObjectId.isValid(user.pharmacyId)
      ? new Types.ObjectId(user.pharmacyId)
      : { $in: [] },
    at: { $gte: query.start, $lt: query.end },
  };
  if (query.actorId) filter.actorId = query.actorId;
  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;
  if (query.search?.trim()) {
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { label: { $regex: escaped, $options: "i" } },
      { entityId: query.search.trim() },
      { note: { $regex: escaped, $options: "i" } },
    ];
  }
  return filter;
}

function toRow(doc: Record<string, unknown>): AuditRow {
  return {
    id: String(doc._id),
    at: new Date(doc.at as Date),
    action: doc.action as AuditAction,
    entity: String(doc.entity ?? ""),
    entityId: String(doc.entityId ?? ""),
    label: String(doc.label ?? ""),
    changes: (doc.changes as AuditRow["changes"]) ?? [],
    actorId: String(doc.actorId ?? ""),
    actorName: String(doc.actorName ?? ""),
    actorRole: String(doc.actorRole ?? ""),
    impersonatorName: String(doc.impersonatorName ?? ""),
    path: String(doc.path ?? ""),
    ip: String(doc.ip ?? ""),
    note: String(doc.note ?? ""),
    verified: verifyAuditEntry(doc),
  };
}

export async function readAuditLog(
  user: SessionUser,
  query: AuditQuery,
  page: { skip: number; limit: number },
): Promise<{ rows: AuditRow[]; total: number }> {
  await connectDB();
  const filter = filterFor(user, query);
  const [docs, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip(page.skip).limit(page.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { rows: docs.map((doc) => toRow(doc as unknown as Record<string, unknown>)), total };
}

/** Everyone who appears in this pharmacy's trail, for the person filter. */
export async function auditActors(
  user: SessionUser,
): Promise<Array<{ id: string; name: string }>> {
  await connectDB();
  const rows = await AuditLog.aggregate<{ _id: string; name: string }>([
    { $match: filterFor(user, { start: new Date(0), end: new Date(8.64e15) }) },
    { $match: { actorId: { $ne: "" } } },
    { $group: { _id: "$actorId", name: { $last: "$actorName" } } },
    { $sort: { name: 1 } },
  ]);
  return rows.map((row) => ({ id: row._id, name: row.name }));
}

/** One value from a change, short enough for a table cell. */
export function describeAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function describeAuditChanges(row: Pick<AuditRow, "changes" | "action">, limit = 8): string {
  // A creation lists what was set, a deletion what was lost, an edit both.
  const value = (change: AuditRow["changes"][number]) =>
    row.action === "create"
      ? `${change.path}: ${describeAuditValue(change.after)}`
      : row.action === "delete"
        ? `${change.path}: ${describeAuditValue(change.before)}`
        : `${change.path}: ${describeAuditValue(change.before)} → ${describeAuditValue(change.after)}`;
  const parts = row.changes
    .slice(0, limit)
    .map(value);
  if (row.changes.length > limit) parts.push(`+${row.changes.length - limit} more`);
  return parts.join("; ");
}

/** The audit trail as a printable / downloadable report. */
export async function auditLogReport(
  user: SessionUser,
  query: AuditQuery & { rangeLabel: string },
): Promise<ReportDataset> {
  const { rows, total } = await readAuditLog(user, query, { skip: 0, limit: 20_000 });
  const unverified = rows.filter((row) => !row.verified).length;

  return {
    title: "Audit Trail",
    subtitle: query.rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Entries", value: String(total) },
      { label: "Failed verification", value: String(unverified) },
    ],
    columns: [
      { key: "at", header: "When (AD)", type: "date" },
      { key: "bs", header: "Date (BS)", type: "text", width: 11 },
      { key: "time", header: "Time", type: "text", width: 8 },
      { key: "who", header: "Who", type: "text", width: 18 },
      { key: "role", header: "Role", type: "text", width: 10 },
      { key: "action", header: "Action", type: "text", width: 12 },
      { key: "entity", header: "Record type", type: "text", width: 14 },
      { key: "record", header: "Record", type: "text", width: 20 },
      { key: "changes", header: "Old → new", type: "text", width: 60 },
      { key: "ip", header: "IP", type: "text", width: 14 },
      { key: "verified", header: "Verified", type: "text", width: 8 },
    ],
    rows: rows.map((row) => ({
      at: row.at,
      bs: bsDateOf(row.at),
      time: formatTime(row.at),
      who: row.impersonatorName ? `${row.actorName} (via ${row.impersonatorName})` : row.actorName,
      role: roleName(row.actorRole),
      action: AUDIT_ACTION_LABELS[row.action] ?? row.action,
      entity: AUDIT_ENTITY_LABELS[row.entity] ?? row.entity,
      record: row.label || row.entityId || row.note,
      changes: row.note && !row.changes.length ? row.note : describeAuditChanges(row),
      ip: row.ip,
      verified: row.verified ? "Yes" : "NO",
    })),
    note: "Append-only. Entries cannot be edited or removed from within the application, and each is signed: 'NO' under Verified means the stored entry was altered after it was written.",
  };
}
