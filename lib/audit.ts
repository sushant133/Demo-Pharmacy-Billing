import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Types,
  type ClientSession,
  type HydratedDocument,
  type Model,
  type Query,
  type Schema,
} from "mongoose";
import { config, requireAuthSecret } from "@/lib/config";
import { currentRequestContext } from "@/lib/request-context";
import { AuditLog, type AuditAction } from "@/models/AuditLog";

/**
 * Audit trail: who changed what, when, and from what to what.
 *
 * `auditPlugin` is attached to every business model. It hooks each write path
 * Mongoose offers - document save, the update/replace/delete queries, and
 * insertMany - reads the affected records before and after, and appends one
 * AuditLog entry per record with the fields that differ.
 *
 * Entries are written with the write's own session, so inside a transaction
 * they commit or roll back with the change. Outside one (standalone MongoDB)
 * they are written straight after it.
 */

/** Fields never copied into the log, only marked as changed. */
const REDACTED = new Set([
  "passwordHash",
  "password",
  "tokenHash",
  "token",
  "secret",
  "cbmsPasswordEnc",
]);
/** Bookkeeping that changes on every write and says nothing. */
const IGNORED = new Set(["updatedAt", "__v"]);
/** Handles that make an entry readable at a glance, in order of preference. */
const LABEL_FIELDS = ["billNo", "grnNo", "name", "email", "batchNumber", "title", "code"];
/** A bulk update touching more than this is logged for the first N records. */
const MAX_RECORDS_PER_WRITE = 500;

export interface AuditChange {
  path: string;
  before: unknown;
  after: unknown;
}

type Plain = Record<string, unknown>;

/** JSON round trip: ObjectIds become strings, Dates ISO strings, so signing is stable. */
function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Field-by-field difference between two versions of one record. */
export function diffRecords(before: Plain | null, after: Plain | null): AuditChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: AuditChange[] = [];
  for (const key of [...keys].sort()) {
    if (IGNORED.has(key)) continue;
    const old = normalise(before?.[key]);
    const now = normalise(after?.[key]);
    if (JSON.stringify(old) === JSON.stringify(now)) continue;
    if (REDACTED.has(key)) {
      changes.push({ path: key, before: old == null ? null : "[redacted]", after: now == null ? null : "[redacted]" });
    } else {
      changes.push({ path: key, before: old, after: now });
    }
  }
  return changes;
}

function labelOf(record: Plain | null): string {
  if (!record) return "";
  for (const field of LABEL_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function auditKey(): string {
  return config.auditSecret.length >= 32 ? config.auditSecret : requireAuthSecret();
}

/** Stable JSON: object keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Plain)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Plain)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const SIGNED_FIELDS = [
  "pharmacyId",
  "at",
  "action",
  "entity",
  "entityId",
  "label",
  "changes",
  "actorId",
  "actorName",
  "actorRole",
  "impersonatorName",
  "method",
  "path",
  "ip",
  "userAgent",
  "note",
] as const;

export function signAuditEntry(entry: Plain): string {
  const body: Plain = {};
  for (const field of SIGNED_FIELDS) body[field] = normalise(entry[field] ?? null);
  return createHmac("sha256", auditKey()).update(canonical(body)).digest("hex");
}

/** True when an entry is exactly as it was written. */
export function verifyAuditEntry(entry: Plain & { signature?: string }): boolean {
  if (!entry.signature) return false;
  const expected = Buffer.from(signAuditEntry(entry), "hex");
  const actual = Buffer.from(entry.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface EntryInput {
  action: AuditAction;
  entity?: string;
  entityId?: string;
  label?: string;
  changes?: AuditChange[];
  pharmacyId?: unknown;
  note?: string;
  /** Overrides the request's actor, for sign-in events before a session exists. */
  actor?: { id: string; name: string; role: string; pharmacyId?: string } | null;
}

function buildEntry(input: EntryInput): Plain {
  const context = currentRequestContext();
  const actor = input.actor !== undefined ? input.actor : context?.actor ?? null;
  const pharmacy =
    input.pharmacyId ?? (actor && "pharmacyId" in actor ? actor.pharmacyId : null) ?? null;

  const entry: Plain = {
    pharmacyId:
      pharmacy && Types.ObjectId.isValid(String(pharmacy))
        ? new Types.ObjectId(String(pharmacy))
        : null,
    at: new Date(),
    action: input.action,
    entity: input.entity ?? "",
    entityId: input.entityId ?? "",
    label: input.label ?? "",
    changes: (input.changes ?? []).map((change) => ({
      path: change.path,
      before: normalise(change.before),
      after: normalise(change.after),
    })),
    actorId: actor?.id ?? "",
    actorName: actor?.name || "System",
    actorRole: actor?.role ?? "",
    impersonatorName:
      context?.actor && "impersonatorName" in context.actor
        ? context.actor.impersonatorName ?? ""
        : "",
    method: context?.method ?? "",
    path: context?.path ?? "",
    ip: context?.ip ?? "",
    userAgent: context?.userAgent ?? "",
    note: input.note ?? "",
  };
  entry.signature = signAuditEntry(entry);
  return entry;
}

async function writeEntries(inputs: EntryInput[], session: ClientSession | null) {
  if (inputs.length === 0) return;
  const docs = inputs.map(buildEntry);
  if (session) {
    // Inside a transaction a failure aborts the write it describes, as it should.
    await AuditLog.insertMany(docs, { session });
    return;
  }
  // Without one, the record is already stored by the time this runs, and throwing
  // would leave the caller half-way: a bill on file with its stock rolled back. A
  // missing log line is the smaller harm, so it is reported as loudly as possible.
  try {
    await AuditLog.insertMany(docs);
  } catch (err) {
    console.error("[audit] ENTRY LOST - could not record a change that was saved", {
      entries: docs.map((doc) => ({ action: doc.action, entity: doc.entity, entityId: doc.entityId })),
      err,
    });
  }
}

/** Sign-in, sign-out and similar events that do not change a record. */
export async function recordSecurityEvent(input: {
  action: Extract<AuditAction, "login" | "login-failed" | "logout">;
  actor?: EntryInput["actor"];
  pharmacyId?: unknown;
  note?: string;
}): Promise<void> {
  try {
    await writeEntries([{ ...input }], null);
  } catch (err) {
    // A sign-in must not fail because its log line could not be written.
    console.error("[audit] could not record security event", err);
  }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const UPDATE_OPS = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
] as const;
const DELETE_OPS = ["deleteOne", "deleteMany", "findOneAndDelete"] as const;

type AnyQuery = Query<unknown, unknown> & {
  _auditBefore?: Plain[];
  op?: string;
};

function querySession(query: AnyQuery): ClientSession | null {
  return (query.getOptions().session as ClientSession | undefined) ?? null;
}

function entityName(model: Model<unknown>): string {
  return model.modelName;
}

export function auditPlugin(schema: Schema, options?: { tenantIsSelf?: boolean }): void {
  // The record that is itself a tenant carries no pharmacyId: it is its own. Without
  // this, a superadmin's edit to a shop lands where that shop's owner cannot see it.
  const pharmacyOf = (record: Plain | null): unknown =>
    options?.tenantIsSelf ? record?._id ?? null : record?.pharmacyId ?? null;

  // Fields a normal read leaves out, which is what makes a password reset show no
  // difference at all. They go through REDACTED, so only the fact of it is logged.
  const hiddenFields: string[] = [];
  schema.eachPath((path, type) => {
    if ((type as { options?: { select?: boolean } }).options?.select === false) hiddenFields.push(`+${path}`);
  });

  // ---- Document saves (create, and doc.save() after edits) ---------------
  schema.pre("save", async function () {
    const doc = this as HydratedDocument<Plain>;
    if (doc.isNew) {
      doc.$locals.auditBefore = null;
      return;
    }
    const model = doc.constructor as Model<Plain>;
    doc.$locals.auditBefore = await model
      .findById(doc._id)
      .session(doc.$session() ?? null)
      .lean();
  });

  schema.post("save", async function (doc: HydratedDocument<Plain>) {
    const before = (doc.$locals.auditBefore as Plain | null | undefined) ?? null;
    const after = doc.toObject({ depopulate: true }) as Plain;
    const changes = diffRecords(before, after);
    if (before && changes.length === 0) return;
    const model = doc.constructor as Model<unknown>;
    await writeEntries(
      [
        {
          action: before ? "update" : "create",
          entity: entityName(model),
          entityId: String(doc._id),
          label: labelOf(after),
          changes,
          pharmacyId: pharmacyOf(after),
        },
      ],
      doc.$session() ?? null,
    );
  });

  schema.post("insertMany", async function (this: Model<unknown>, docs: unknown) {
    const list = (Array.isArray(docs) ? docs : [docs]) as Array<HydratedDocument<Plain>>;
    const first = list[0];
    const session = first?.$session?.() ?? null;
    await writeEntries(
      list.map((doc) => {
        const after = (typeof doc.toObject === "function" ? doc.toObject() : doc) as Plain;
        return {
          action: "create" as const,
          entity: entityName(this),
          entityId: String(after._id),
          label: labelOf(after),
          changes: diffRecords(null, after),
          pharmacyId: pharmacyOf(after),
        };
      }),
      session,
    );
  });

  // ---- Query updates -----------------------------------------------------
  schema.pre([...UPDATE_OPS], async function (this: unknown) {
    const query = this as unknown as AnyQuery;
    const single = query.op === "findOneAndUpdate" || query.op === "updateOne" ||
      query.op === "replaceOne" || query.op === "findOneAndReplace";
    query._auditBefore = (await query.model
      .find(query.getFilter())
      .select(hiddenFields.join(" "))
      .session(querySession(query))
      .limit(single ? 1 : MAX_RECORDS_PER_WRITE)
      .lean()) as Plain[];
  });

  schema.post([...UPDATE_OPS], async function (this: unknown, result: unknown) {
    const query = this as unknown as AnyQuery;
    const session = querySession(query);
    const before = query._auditBefore ?? [];
    const ids: unknown[] = before.map((record) => record._id);

    // An upsert that created the record: there was nothing to read before.
    const upsertedId =
      (result as { upsertedId?: unknown } | null)?.upsertedId ??
      (before.length === 0 && result && typeof result === "object" && "_id" in result
        ? (result as { _id: unknown })._id
        : null);
    if (upsertedId) ids.push(upsertedId);
    if (ids.length === 0) return;

    const afterList = (await query.model
      .find({ _id: { $in: ids } })
      .select(hiddenFields.join(" "))
      .session(session)
      .lean()) as Plain[];
    const afterById = new Map(afterList.map((record) => [String(record._id), record]));
    const beforeById = new Map(before.map((record) => [String(record._id), record]));

    const entries: EntryInput[] = [];
    for (const id of ids.map(String)) {
      const old = beforeById.get(id) ?? null;
      const now = afterById.get(id) ?? null;
      const changes = diffRecords(old, now);
      if (changes.length === 0) continue;
      entries.push({
        action: old ? "update" : "create",
        entity: entityName(query.model as Model<unknown>),
        entityId: id,
        label: labelOf(now ?? old),
        changes,
        pharmacyId: pharmacyOf(now ?? old),
      });
    }
    await writeEntries(entries, session);
  });

  // ---- Query deletes -----------------------------------------------------
  schema.pre([...DELETE_OPS], async function (this: unknown) {
    const query = this as unknown as AnyQuery;
    const single = query.op === "deleteOne" || query.op === "findOneAndDelete";
    query._auditBefore = (await query.model
      .find(query.getFilter())
      .session(querySession(query))
      .limit(single ? 1 : MAX_RECORDS_PER_WRITE)
      .lean()) as Plain[];
  });

  schema.post([...DELETE_OPS], async function (this: unknown) {
    const query = this as unknown as AnyQuery;
    const session = querySession(query);
    const before = query._auditBefore ?? [];
    if (before.length === 0) return;

    // Only the ones that are actually gone: a guarded delete can match nothing.
    const remaining = (await query.model
      .find({ _id: { $in: before.map((record) => record._id) } })
      .session(session)
      .select("_id")
      .lean()) as Plain[];
    const still = new Set(remaining.map((record) => String(record._id)));

    await writeEntries(
      before
        .filter((record) => !still.has(String(record._id)))
        .map((record) => ({
          action: "delete" as const,
          entity: entityName(query.model as Model<unknown>),
          entityId: String(record._id),
          label: labelOf(record),
          changes: diffRecords(record, null),
          pharmacyId: pharmacyOf(record),
        })),
      session,
    );
  });
}
