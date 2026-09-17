import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { money } from "@/lib/format";
import { MOVEMENT_KIND_LABELS, type MovementKind } from "@/lib/movement-kinds";
import { pharmacyFilter } from "@/lib/tenant";
import { Prescription } from "@/models/Prescription";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { StockMovement } from "@/models/StockMovement";
import { SupplierPayment } from "@/models/SupplierPayment";
import { User } from "@/models/User";
import type { SessionUser } from "@/lib/session";

/**
 * Who did what, read back from the records themselves.
 *
 * There is no audit-log collection and this does not add one. Every action
 * worth reporting already stamps its author on the document it produced - a
 * bill carries `soldByName`, a void carries `voidedBy`, a stock movement
 * carries `performedBy` - so the honest way to answer "what did Sunita do last
 * week?" is to read those, not to start writing a parallel record that can
 * drift from them.
 *
 * The same reasoning as lib/stock-ledger.ts, and the same trade: a merge in
 * application code instead of one query, in exchange for a history that is
 * correct for everything that happened before anyone thought to log it. There
 * is no cut-over date and no gap.
 *
 * What this cannot show is anything that leaves no document behind: reading a
 * report, opening a customer's record, a failed sign-in. Those need logging at
 * the point of the action, and nothing writes it.
 */

export const ACTIVITY_KINDS = [
  "sale",
  "sale-void",
  "sale-return",
  "sale-payment",
  "purchase",
  "supplier-payment",
  "stock",
  "prescription",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  sale: "Billing",
  "sale-void": "Voids",
  "sale-return": "Customer returns",
  "sale-payment": "Payments received",
  purchase: "Purchasing",
  "supplier-payment": "Supplier payments",
  stock: "Stock movements",
  prescription: "Prescriptions",
};

export const ACTIVITY_TONE: Record<
  ActivityKind,
  "slate" | "brand" | "green" | "amber" | "rose"
> = {
  sale: "brand",
  "sale-void": "rose",
  "sale-return": "amber",
  "sale-payment": "green",
  purchase: "slate",
  "supplier-payment": "green",
  stock: "amber",
  prescription: "brand",
};

export interface ActivityEntry {
  id: string;
  at: Date;
  kind: ActivityKind;
  /** Null where the record stamped a name but not an id. */
  userId: string | null;
  userName: string;
  /** What they did, in the past tense. */
  action: string;
  /** The document it happened to. */
  subject: string;
  href: string | null;
  detail: string;
}

export interface ActivityQuery {
  scope: BranchScope;
  start: Date;
  end: Date;
  /** Restrict to one person, by user id. */
  userId?: string | null;
  kinds?: readonly ActivityKind[];
}

/** Per-person totals for the summary strip, over the whole range. */
export interface ActivityByUser {
  userId: string | null;
  userName: string;
  count: number;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  byUser: ActivityByUser[];
  byKind: Array<{ kind: ActivityKind; count: number }>;
}

/** Each source is capped, so one busy collection cannot crowd out the rest. */
const PER_SOURCE = 500;

export async function readActivity(
  user: SessionUser,
  query: ActivityQuery,
): Promise<ActivityPage> {
  await connectDB();

  const { scope, start, end } = query;
  const range = { $gte: start, $lt: end };
  const wants = (kind: ActivityKind) =>
    query.kinds ? query.kinds.includes(kind) : true;

  // Purchases stamp `postedBy` and `cancelledBy` as ids without a name beside
  // them, unlike everything else. One lookup of this pharmacy's people covers
  // both, rather than a populate per row.
  const staff = await User.find(pharmacyFilter(user)).select("name").lean();
  const nameOf = new Map(staff.map((row) => [String(row._id), row.name]));

  const sources: Array<Promise<ActivityEntry[]>> = [];

  if (
    wants("sale") ||
    wants("sale-void") ||
    wants("sale-return") ||
    wants("sale-payment")
  ) {
    sources.push(fromSales(scope, range));
  }
  if (wants("purchase")) sources.push(fromPurchases(scope, range, nameOf));
  if (wants("supplier-payment")) sources.push(fromSupplierPayments(user, range));
  if (wants("stock")) sources.push(fromStockMovements(scope, range));
  if (wants("prescription")) sources.push(fromPrescriptions(scope, range));

  const all = (await Promise.all(sources)).flat();

  const entries = all
    .filter((entry) => (query.kinds ? query.kinds.includes(entry.kind) : true))
    .filter((entry) =>
      query.userId ? entry.userId === query.userId : true,
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const byUser = new Map<string, ActivityByUser>();
  const byKind = new Map<ActivityKind, number>();

  for (const entry of entries) {
    const key = entry.userId ?? entry.userName;
    const row = byUser.get(key) ?? {
      userId: entry.userId,
      userName: entry.userName,
      count: 0,
    };
    row.count += 1;
    byUser.set(key, row);
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  }

  return {
    entries,
    byUser: [...byUser.values()].sort((a, b) => b.count - a.count),
    byKind: [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Bills, and the three things that happen to them afterwards.
 *
 * One read rather than four: a void, a return and a receipt all live on the
 * sale they belong to, so fetching the bill once and walking its arrays beats
 * four queries against the same documents.
 */
async function fromSales(
  scope: BranchScope,
  range: Record<string, Date>,
): Promise<ActivityEntry[]> {
  const rows = await Sale.find({
    ...branchFilter(scope),
    // A bill raised before the range can still have been voided or paid inside
    // it, so the match is "anything on this bill happened in the window".
    $or: [
      { createdAt: range },
      { voidedAt: range },
      { "returns.returnedAt": range },
      { "payments.receivedAt": range },
    ],
  })
    .select(
      "billNo totalAmount customerName createdAt soldBy soldByName voidedAt voidedBy voidedByName voidReason returns payments",
    )
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE)
    .lean();

  const entries: ActivityEntry[] = [];
  const inRange = (at: Date | null | undefined) =>
    Boolean(at && at >= range.$gte! && at < range.$lt!);

  for (const sale of rows) {
    const id = String(sale._id);
    const href = `/sales/${id}`;
    const createdAt = sale.createdAt as unknown as Date;

    if (inRange(createdAt)) {
      entries.push({
        id: `${id}-sale`,
        at: createdAt,
        kind: "sale",
        userId: sale.soldBy ? String(sale.soldBy) : null,
        userName: sale.soldByName || "Unknown",
        action: "Raised a bill",
        subject: sale.billNo,
        href,
        detail: `${money(sale.totalAmount)}${sale.customerName ? ` · ${sale.customerName}` : ""}`,
      });
    }

    const voidedAt = sale.voidedAt as unknown as Date | null;
    if (inRange(voidedAt)) {
      entries.push({
        id: `${id}-void`,
        at: voidedAt!,
        kind: "sale-void",
        userId: sale.voidedBy ? String(sale.voidedBy) : null,
        userName: sale.voidedByName || "Unknown",
        action: "Voided a bill",
        subject: sale.billNo,
        href,
        detail: sale.voidReason || money(sale.totalAmount),
      });
    }

    for (const [index, entry] of (sale.returns ?? []).entries()) {
      const at = entry.returnedAt as unknown as Date;
      if (!inRange(at)) continue;
      entries.push({
        id: `${id}-return-${index}`,
        at,
        kind: "sale-return",
        userId: entry.returnedBy ? String(entry.returnedBy) : null,
        userName: entry.returnedByName || "Unknown",
        action: "Recorded a return",
        subject: sale.billNo,
        href,
        detail: `${entry.units} unit${entry.units === 1 ? "" : "s"} · ${money(entry.totalAmount)}`,
      });
    }

    for (const [index, entry] of (sale.payments ?? []).entries()) {
      const at = entry.receivedAt as unknown as Date;
      // The till payment is part of raising the bill, not a separate act -
      // listing both would double every cash sale in the feed.
      if (entry.atTill || !inRange(at)) continue;
      entries.push({
        id: `${id}-payment-${index}`,
        at,
        kind: "sale-payment",
        userId: entry.receivedBy ? String(entry.receivedBy) : null,
        userName: entry.receivedByName || "Unknown",
        action: "Received a payment",
        subject: sale.billNo,
        href,
        detail: `${money(entry.amount)} by ${entry.method}`,
      });
    }
  }

  return entries;
}

async function fromPurchases(
  scope: BranchScope,
  range: Record<string, Date>,
  nameOf: Map<string, string>,
): Promise<ActivityEntry[]> {
  const rows = await Purchase.find({
    ...branchFilter(scope),
    $or: [{ createdAt: range }, { postedAt: range }, { cancelledAt: range }],
  })
    .select(
      "grnNo supplierName grandTotal createdAt createdBy createdByName postedAt postedBy cancelledAt cancelledBy cancelReason",
    )
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE)
    .lean();

  const entries: ActivityEntry[] = [];
  const inRange = (at: Date | null | undefined) =>
    Boolean(at && at >= range.$gte! && at < range.$lt!);

  for (const purchase of rows) {
    const id = String(purchase._id);
    const href = `/purchases/${id}`;
    const detail = purchase.supplierName ?? "";

    const createdAt = purchase.createdAt as unknown as Date;
    if (inRange(createdAt)) {
      entries.push({
        id: `${id}-created`,
        at: createdAt,
        kind: "purchase",
        userId: purchase.createdBy ? String(purchase.createdBy) : null,
        userName: purchase.createdByName || "Unknown",
        action: "Raised a purchase",
        subject: purchase.grnNo,
        href,
        detail,
      });
    }

    const postedAt = purchase.postedAt as unknown as Date | null;
    if (inRange(postedAt)) {
      const by = purchase.postedBy ? String(purchase.postedBy) : null;
      entries.push({
        id: `${id}-posted`,
        at: postedAt!,
        kind: "purchase",
        userId: by,
        userName: (by ? nameOf.get(by) : null) ?? purchase.createdByName ?? "Unknown",
        action: "Posted a purchase",
        subject: purchase.grnNo,
        href,
        detail: detail ? `${detail} · stock received` : "Stock received",
      });
    }

    const cancelledAt = purchase.cancelledAt as unknown as Date | null;
    if (inRange(cancelledAt)) {
      const by = purchase.cancelledBy ? String(purchase.cancelledBy) : null;
      entries.push({
        id: `${id}-cancelled`,
        at: cancelledAt!,
        kind: "purchase",
        userId: by,
        userName: (by ? nameOf.get(by) : null) ?? "Unknown",
        action: "Cancelled a purchase",
        subject: purchase.grnNo,
        href,
        detail: purchase.cancelReason || detail,
      });
    }
  }

  return entries;
}

async function fromSupplierPayments(
  user: SessionUser,
  range: Record<string, Date>,
): Promise<ActivityEntry[]> {
  const rows = await SupplierPayment.find({
    ...pharmacyFilter(user),
    createdAt: range,
  })
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE)
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    at: row.createdAt as unknown as Date,
    kind: "supplier-payment" as const,
    userId: row.recordedBy ? String(row.recordedBy) : null,
    userName: row.recordedByName || "Unknown",
    action: "Paid a supplier",
    subject: row.grnNo || "On account",
    href: `/suppliers/${String(row.supplierId)}`,
    detail: `${money(row.amount)} by ${row.method}`,
  }));
}

async function fromStockMovements(
  scope: BranchScope,
  range: Record<string, Date>,
): Promise<ActivityEntry[]> {
  const rows = await StockMovement.find({
    ...branchFilter(scope),
    createdAt: range,
  })
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE)
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    at: row.createdAt as unknown as Date,
    kind: "stock" as const,
    userId: row.performedBy ? String(row.performedBy) : null,
    userName: row.performedByName || "Unknown",
    action: MOVEMENT_KIND_LABELS[row.kind as MovementKind] ?? "Moved stock",
    subject: row.batchNumber || row.medicineName,
    href: "/inventory/stock-out",
    detail: `${row.direction === "in" ? "+" : "−"}${row.quantity} ${row.medicineName}${row.reason ? ` · ${row.reason}` : ""}`,
  }));
}

async function fromPrescriptions(
  scope: BranchScope,
  range: Record<string, Date>,
): Promise<ActivityEntry[]> {
  const rows = await Prescription.find({
    ...branchFilter(scope),
    $or: [
      { createdAt: range },
      { cancelledAt: range },
      { "dispenses.dispensedAt": range },
    ],
  })
    .select(
      "rxNo patientName createdAt createdBy createdByName cancelledAt cancelledBy cancelledByName cancelReason dispenses",
    )
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE)
    .lean();

  const entries: ActivityEntry[] = [];
  const inRange = (at: Date | null | undefined) =>
    Boolean(at && at >= range.$gte! && at < range.$lt!);

  for (const script of rows) {
    const id = String(script._id);
    const href = `/prescriptions/${id}`;

    const createdAt = script.createdAt as unknown as Date;
    if (inRange(createdAt)) {
      entries.push({
        id: `${id}-filed`,
        at: createdAt,
        kind: "prescription",
        userId: script.createdBy ? String(script.createdBy) : null,
        userName: script.createdByName || "Unknown",
        action: "Filed a prescription",
        subject: script.rxNo,
        href,
        detail: script.patientName,
      });
    }

    for (const [index, entry] of (script.dispenses ?? []).entries()) {
      const at = entry.dispensedAt as unknown as Date;
      if (!inRange(at)) continue;
      entries.push({
        id: `${id}-dispense-${index}`,
        at,
        kind: "prescription",
        userId: entry.dispensedBy ? String(entry.dispensedBy) : null,
        userName: entry.dispensedByName || "Unknown",
        action: "Dispensed a prescription",
        subject: script.rxNo,
        href,
        detail: `${entry.units} unit${entry.units === 1 ? "" : "s"} · ${script.patientName}`,
      });
    }

    const cancelledAt = script.cancelledAt as unknown as Date | null;
    if (inRange(cancelledAt)) {
      entries.push({
        id: `${id}-cancelled`,
        at: cancelledAt!,
        kind: "prescription",
        userId: script.cancelledBy ? String(script.cancelledBy) : null,
        userName: script.cancelledByName || "Unknown",
        action: "Cancelled a prescription",
        subject: script.rxNo,
        href,
        detail: script.cancelReason || script.patientName,
      });
    }
  }

  return entries;
}
