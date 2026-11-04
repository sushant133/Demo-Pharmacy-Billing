import { Types, type ClientSession } from "mongoose";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { adToBs } from "@/lib/bs-date";
import { fiscalYearOf, localParts } from "@/lib/dates";
import { openSecret } from "@/lib/secret-box";
import { getSettings, printedIssuer } from "@/lib/settings";
import { sessionOption } from "@/lib/transaction";
import { CbmsSync, type CbmsKind, type CbmsStatus } from "@/models/CbmsSync";
import { Sale } from "@/models/Sale";
import { Setting } from "@/models/Setting";

/**
 * IRD Central Billing Monitoring System (CBMS).
 *
 * A VAT-registered business above IRD's turnover threshold has to report every
 * sales invoice and every sales return to CBMS as it is issued. This module:
 *
 *   - queues a row for each bill, return and cancellation, inside the same
 *     transaction that creates it (`queueCbms`);
 *   - sends a row straight after the transaction commits (`syncCbmsNow`), so
 *     in the normal case the bill reaches IRD in real time;
 *   - retries whatever did not get through, with back-off, from a runner that
 *     starts with the server (`startCbmsRunner`, see instrumentation.ts), and
 *     on demand from the CBMS screen.
 *
 * The request and response shapes follow IRD's published CBMS API: POST
 * /api/bill for a sale and POST /api/billreturn for a return, answering with a
 * bare status code. Run a few bills against IRD's test server before turning
 * it on for a live shop.
 */

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** What CBMS's numeric answers mean, for the screen and the log. */
export const CBMS_RESPONSE_LABELS: Record<number, string> = {
  200: "Accepted by IRD",
  100: "CBMS username or password not accepted",
  101: "Already recorded at IRD",
  102: "IRD could not save the record",
  103: "Unknown error at IRD",
  104: "IRD rejected the data as invalid",
  105: "IRD has no record of the original invoice",
};

const CBMS_BAD_LOGIN = 100;

/** Codes that mean IRD now holds the document. 101: it already did. */
const ACCEPTED = new Set([200, 101]);

/** How long a claimed row is left alone, so two runners never send it twice. */
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

// ---------------------------------------------------------------------------
// Formats CBMS expects
// ---------------------------------------------------------------------------

/** "2082-83" → "2082.083", the fiscal-year form in IRD's API. */
export function cbmsFiscalYear(fiscalYear: string): string {
  const match = /^(\d{4})-(\d{2,3})$/.exec(fiscalYear.trim());
  if (!match) return fiscalYear;
  return `${match[1]}.${match[2]!.padStart(3, "0")}`;
}

/** BS date as "2082.04.15". */
export function cbmsDate(instant: Date): string {
  const local = localParts(instant);
  const bs = adToBs(local.year, local.month, local.day);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${bs.year}.${pad(bs.month)}.${pad(bs.day)}`;
}

/** Local wall-clock time of the client, "2026-10-23T14:05:09". */
export function cbmsClientTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

export interface CbmsCredentials {
  username: string;
  password: string;
  sellerPan: string;
}

interface Amounts {
  total: number;
  taxable: number;
  exempt: number;
  vat: number;
}

function amountFields(amounts: Amounts) {
  return {
    total_sales: round2(amounts.total),
    taxable_sales_vat: round2(amounts.taxable - amounts.exempt),
    vat: round2(amounts.vat),
    excisable_amount: 0,
    excise: 0,
    taxable_sales_hst: 0,
    hst: 0,
    amount_for_esf: 0,
    esf: 0,
    export_sales: 0,
    tax_exempted_sales: round2(amounts.exempt),
  };
}

export interface BillForCbms {
  billNo: string;
  fiscalYear?: string | null;
  createdAt: Date;
  customerName?: string | null;
  customerPan?: string | null;
  totalAmount: number;
  taxableAmount: number;
  exemptAmount?: number | null;
  vatAmount: number;
}

export function billPayload(
  sale: BillForCbms,
  credentials: CbmsCredentials,
  realtime: boolean,
  now = new Date(),
) {
  return {
    username: credentials.username,
    password: credentials.password,
    seller_pan: credentials.sellerPan,
    buyer_pan: (sale.customerPan ?? "").trim(),
    buyer_name: (sale.customerName ?? "").trim(),
    fiscal_year: cbmsFiscalYear(sale.fiscalYear || fiscalYearOf(sale.createdAt)),
    invoice_number: sale.billNo,
    invoice_date: cbmsDate(sale.createdAt),
    ...amountFields({
      total: sale.totalAmount,
      taxable: sale.taxableAmount,
      exempt: sale.exemptAmount ?? 0,
      vat: sale.vatAmount,
    }),
    isrealtime: realtime,
    datetimeClient: cbmsClientTime(now),
  };
}

export interface ReturnForCbms {
  creditNoteNo: string;
  issuedAt: Date;
  reason: string;
  totalAmount: number;
  taxableAmount: number;
  exemptAmount?: number | null;
  vatAmount: number;
}

export function returnPayload(
  sale: BillForCbms,
  note: ReturnForCbms,
  credentials: CbmsCredentials,
  realtime: boolean,
  now = new Date(),
) {
  return {
    username: credentials.username,
    password: credentials.password,
    seller_pan: credentials.sellerPan,
    buyer_pan: (sale.customerPan ?? "").trim(),
    buyer_name: (sale.customerName ?? "").trim(),
    fiscal_year: cbmsFiscalYear(fiscalYearOf(note.issuedAt)),
    ref_invoice_number: sale.billNo,
    credit_note_number: note.creditNoteNo,
    credit_note_date: cbmsDate(note.issuedAt),
    reason_for_return: (note.reason || "Sales return").slice(0, 200),
    ...amountFields({
      total: note.totalAmount,
      taxable: note.taxableAmount,
      exempt: note.exemptAmount ?? 0,
      vat: note.vatAmount,
    }),
    isrealtime: realtime,
    datetimeClient: cbmsClientTime(now),
  };
}

/** The number CBMS answers with. It sends a bare JSON number; be forgiving. */
export function parseCbmsResponse(text: string): number | null {
  const trimmed = text.trim().replace(/^"|"$/g, "");
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "number") return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["status", "code", "statusCode", "responseCode"]) {
        const value = Number((parsed as Record<string, unknown>)[key]);
        if (Number.isFinite(value)) return value;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Null when this pharmacy has not switched CBMS on, or has no login saved. */
export async function cbmsCredentials(
  pharmacyId: Types.ObjectId | string,
  branchId?: unknown,
): Promise<CbmsCredentials | null> {
  const setting = await Setting.findOne({ pharmacyId, key: "business" })
    .select("cbmsEnabled cbmsUsername cbmsPasswordEnc")
    .lean();
  if (!setting?.cbmsEnabled || !setting.cbmsUsername) return null;
  const password = openSecret(setting.cbmsPasswordEnc);
  if (!password) return null;

  const settings = await getSettings(pharmacyId);
  const issuer = await printedIssuer(settings, branchId, pharmacyId);
  return { username: setting.cbmsUsername, password, sellerPan: issuer.pan };
}

// ---------------------------------------------------------------------------
// Queueing (inside the business transaction)
// ---------------------------------------------------------------------------

export async function queueCbms(
  entry: {
    pharmacyId: Types.ObjectId;
    saleId: Types.ObjectId;
    kind: CbmsKind;
    returnIndex?: number | null;
    documentNo: string;
    issuedAt: Date;
    /**
     * False while the shop has CBMS off. The row is still written, parked as
     * "disabled": nothing may be silently dropped, and the retry runner leaves
     * it alone until "Send now" pushes the backlog.
     */
    enabled?: boolean;
  },
  session: ClientSession | null,
): Promise<string> {
  const { enabled = true, ...row } = entry;
  const [created] = await CbmsSync.create(
    [
      {
        ...row,
        returnIndex: row.returnIndex ?? null,
        status: enabled ? "pending" : "disabled",
        nextAttemptAt: new Date(),
      },
    ],
    sessionOption(session),
  );
  return String(created!._id);
}

/** Enough of a bill to work out what IRD should have heard about it. */
export interface SaleForBackfill {
  billNo: string;
  createdAt: Date;
  voidedAt?: Date | null;
  returns?: Array<{ returnedAt: Date; creditNoteNo?: string | null }> | null;
}

/** The queue rows a bill raised before everything was queued should have. */
export function missingCbmsRows(sale: SaleForBackfill): Array<{
  kind: CbmsKind;
  returnIndex: number | null;
  documentNo: string;
  issuedAt: Date;
}> {
  return [
    { kind: "bill" as const, returnIndex: null, documentNo: sale.billNo, issuedAt: sale.createdAt },
    ...(sale.returns ?? []).map((entry, index) => ({
      kind: "return" as const,
      returnIndex: index,
      documentNo: entry.creditNoteNo || `${sale.billNo}/R${index + 1}`,
      issuedAt: entry.returnedAt,
    })),
    ...(sale.voidedAt
      ? [
          {
            kind: "cancel" as const,
            returnIndex: null,
            documentNo: `${sale.billNo}-CANCEL`,
            issuedAt: sale.voidedAt,
          },
        ]
      : []),
  ];
}

const NEVER_QUEUED = { $in: ["none", null] };

/** Bills from before everything was queued. They have never been offered to IRD. */
export async function cbmsNeverQueuedCount(pharmacyId: string | Types.ObjectId): Promise<number> {
  await connectDB();
  return Sale.countDocuments({
    pharmacyId: new Types.ObjectId(String(pharmacyId)),
    cbmsStatus: NEVER_QUEUED,
  });
}

/**
 * Put older bills on the queue, so the bulk push reaches them too. Upserts on
 * the row's unique key, so running it twice cannot queue anything twice.
 */
export async function queueNeverQueuedBills(
  pharmacyId: string | Types.ObjectId,
  limit = 500,
): Promise<number> {
  await connectDB();
  const id = new Types.ObjectId(String(pharmacyId));
  const sales = await Sale.find({ pharmacyId: id, cbmsStatus: NEVER_QUEUED })
    .select("billNo createdAt voidedAt returns.returnedAt returns.creditNoteNo")
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const sale of sales) {
    const rows = missingCbmsRows(sale as unknown as SaleForBackfill);
    for (const row of rows) {
      await CbmsSync.updateOne(
        { saleId: sale._id, kind: row.kind, returnIndex: row.returnIndex },
        {
          $setOnInsert: {
            pharmacyId: id,
            documentNo: row.documentNo,
            issuedAt: row.issuedAt,
            status: "disabled",
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
    await Sale.updateOne({ _id: sale._id }, { $set: { cbmsStatus: "disabled" } });
  }
  return sales.length;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function post(path: string, body: unknown): Promise<{ code: number | null; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.cbms.timeoutMs);
  try {
    const response = await fetch(`${config.cbms.apiUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const code = parseCbmsResponse(text);
    if (code === null) {
      return { code: null, message: `Unexpected answer from IRD (HTTP ${response.status}): ${text.slice(0, 200)}` };
    }
    return { code, message: CBMS_RESPONSE_LABELS[code] ?? `IRD answered ${code}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      code: null,
      message: aborted
        ? `IRD did not answer within ${Math.round(config.cbms.timeoutMs / 1000)}s`
        : `Could not reach IRD: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function finish(
  rowId: Types.ObjectId,
  saleId: Types.ObjectId,
  kind: CbmsKind,
  attempts: number,
  status: CbmsStatus,
  code: number | null,
  message: string,
): Promise<void> {
  const now = new Date();
  await CbmsSync.updateOne(
    { _id: rowId },
    {
      $set: {
        status,
        responseCode: code,
        responseMessage: message,
        leaseUntil: null,
        syncedAt: status === "synced" ? now : null,
        nextAttemptAt: status === "failed" ? new Date(now.getTime() + backoffMs(attempts)) : null,
      },
    },
  );
  // The bill carries its own outcome; a return's lives on its queue row.
  if (kind === "bill") {
    await Sale.updateOne(
      { _id: saleId },
      {
        $set: {
          cbmsStatus: status,
          cbmsSyncedAt: status === "synced" ? now : null,
          cbmsResponseCode: code,
          cbmsMessage: message,
        },
      },
    );
  }
}

export interface CbmsAttempt {
  id: string;
  status: CbmsStatus;
  code: number | null;
  message: string;
  /** IRD could not be reached, or refused the login: no point trying more rows. */
  stopRun?: boolean;
}

/**
 * Try to send one queued row. Safe to call twice at once: the row is claimed
 * with a lease first, and the loser does nothing.
 */
export async function syncCbmsRow(id: string, opts: { force?: boolean } = {}): Promise<CbmsAttempt | null> {
  await connectDB();
  const now = new Date();
  const claimed = await CbmsSync.findOneAndUpdate(
    {
      _id: id,
      status: { $in: ["pending", "failed", "disabled"] },
      // Force skips the back-off, but never the lease: two sends at once would
      // report one document to IRD twice.
      $and: [
        { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        ...(opts.force ? [] : [{ $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }]),
      ],
    },
    {
      $set: {
        lastAttemptAt: now,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
  if (!claimed) return null;

  const rowId = claimed._id as Types.ObjectId;
  const saleId = claimed.saleId as Types.ObjectId;
  const kind = claimed.kind as CbmsKind;
  const done = async (status: CbmsStatus, code: number | null, message: string) => {
    await finish(rowId, saleId, kind, claimed.attempts, status, code, message);
    return { id: String(rowId), status, code, message };
  };

  const sale = await Sale.findById(saleId).lean();
  if (!sale) return done("failed", null, "The bill no longer exists.");

  const credentials = await cbmsCredentials(sale.pharmacyId, sale.branchId);
  if (!credentials) {
    return done("disabled", null, "CBMS is switched off, or no CBMS login is saved in Settings.");
  }
  if (!credentials.sellerPan) {
    return done("failed", null, "No seller PAN is set for this pharmacy.");
  }

  // A return or cancellation only makes sense to IRD once the bill is there.
  if (kind !== "bill") {
    const bill = await CbmsSync.findOne({ saleId, kind: "bill" }).select("status").lean();
    if (bill && bill.status !== "synced") {
      await CbmsSync.updateOne(
        { _id: rowId },
        {
          $set: {
            status: "pending",
            leaseUntil: null,
            responseMessage: "Waiting for the original invoice to reach IRD first.",
            nextAttemptAt: new Date(now.getTime() + 60_000),
          },
          $inc: { attempts: -1 },
        },
      );
      return { id: String(rowId), status: "pending", code: null, message: "Waiting for the invoice." };
    }
  }

  const issuedAt = new Date(claimed.issuedAt as Date);
  const realtime = now.getTime() - issuedAt.getTime() < 5 * 60 * 1000;

  let result: { code: number | null; message: string };
  if (kind === "bill") {
    result = await post("/api/bill", billPayload(sale, credentials, realtime, now));
  } else if (kind === "return") {
    const entry = sale.returns?.[claimed.returnIndex ?? -1];
    if (!entry) return done("failed", null, "The return no longer exists on the bill.");
    result = await post(
      "/api/billreturn",
      returnPayload(
        sale,
        {
          creditNoteNo: entry.creditNoteNo || claimed.documentNo,
          issuedAt: new Date(entry.returnedAt),
          reason: entry.reason ?? "",
          totalAmount: entry.totalAmount,
          taxableAmount: entry.taxableAmount,
          exemptAmount: entry.exemptAmount ?? 0,
          vatAmount: entry.vatAmount,
        },
        credentials,
        realtime,
        now,
      ),
    );
  } else {
    // A cancelled bill is reported as a return of everything still on it.
    result = await post(
      "/api/billreturn",
      returnPayload(
        sale,
        {
          creditNoteNo: claimed.documentNo,
          issuedAt: new Date((sale.voidedAt as Date | null) ?? issuedAt),
          reason: `Invoice cancelled: ${sale.voidReason || "no reason given"}`,
          totalAmount: sale.totalAmount - (sale.returnedTotal ?? 0),
          taxableAmount: sale.taxableAmount - (sale.returnedTaxable ?? 0),
          exemptAmount: (sale.exemptAmount ?? 0) - (sale.returnedExempt ?? 0),
          vatAmount: sale.vatAmount - (sale.returnedVat ?? 0),
        },
        credentials,
        realtime,
        now,
      ),
    );
  }

  const accepted = result.code !== null && ACCEPTED.has(result.code);
  const attempt = await done(accepted ? "synced" : "failed", result.code, result.message);
  // No proper answer, or a refused login: every other row would go the same way.
  return { ...attempt, stopRun: result.code === null || result.code === CBMS_BAD_LOGIN };
}

/** Send straight away, swallowing errors: a bill must never fail because IRD is down. */
export async function syncCbmsNow(id: string | null | undefined): Promise<void> {
  if (!id) return;
  try {
    await syncCbmsRow(id, { force: true });
  } catch (err) {
    console.error("[cbms] immediate send failed; left for retry", err);
  }
}

/** Retry everything that is due, oldest first. Returns how many were attempted. */
export async function syncDueCbms(
  options: {
    limit?: number;
    pharmacyId?: string | Types.ObjectId;
    force?: boolean;
    /** Stop starting new rows after this long, for a caller someone is waiting on. */
    budgetMs?: number;
  } = {},
): Promise<number> {
  await connectDB();
  const started = Date.now();
  // A forced run (the "Send now" button) also picks up rows parked while CBMS
  // was switched off, so turning it on and pressing the button catches up.
  const filter: Record<string, unknown> = {
    status: { $in: options.force ? ["pending", "failed", "disabled"] : ["pending", "failed"] },
  };
  if (!options.force) filter.nextAttemptAt = { $lte: new Date() };
  if (options.pharmacyId) filter.pharmacyId = new Types.ObjectId(String(options.pharmacyId));
  const due = await CbmsSync.find(filter)
    .sort({ issuedAt: 1 })
    .limit(options.limit ?? 50)
    .select("_id")
    .lean();
  let attempted = 0;
  for (const row of due) {
    if (options.budgetMs && Date.now() - started > options.budgetMs) break;
    const result = await syncCbmsRow(String(row._id), { force: options.force });
    if (result) attempted += 1;
    // With IRD down, 200 rows at 8 seconds each is half an hour of nothing.
    if (result?.stopRun) break;
  }
  return attempted;
}

// ---------------------------------------------------------------------------
// The retry runner
// ---------------------------------------------------------------------------

const RUNNER_KEY = Symbol.for("mantrapharma.cbms-runner");

/** Start the background retry loop once per server process. */
export function startCbmsRunner(): void {
  const holder = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
  if (holder[RUNNER_KEY] || config.cbms.retryIntervalMs <= 0) return;
  let running = false;
  holder[RUNNER_KEY] = setInterval(() => {
    if (running) return;
    running = true;
    syncDueCbms({ limit: 50 })
      .catch((err) => console.error("[cbms] retry run failed", err))
      .finally(() => {
        running = false;
      });
  }, config.cbms.retryIntervalMs);
  holder[RUNNER_KEY]?.unref?.();
}

// ---------------------------------------------------------------------------
// Reading back, for the CBMS screen
// ---------------------------------------------------------------------------

export async function cbmsCounts(pharmacyId: string | Types.ObjectId) {
  await connectDB();
  const rows = await CbmsSync.aggregate<{ _id: CbmsStatus; count: number }>([
    { $match: { pharmacyId: new Types.ObjectId(String(pharmacyId)) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts: Record<CbmsStatus, number> = { pending: 0, synced: 0, failed: 0, disabled: 0 };
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}
