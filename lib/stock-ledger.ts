import { connectDB } from "@/lib/db";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import {
  MOVEMENT_KIND_LABELS,
  MOVEMENT_REASON_LABELS,
  type MovementDirection,
  type MovementKind,
  type MovementReason,
} from "@/lib/movement-kinds";
import { round2 } from "@/lib/sale-payment";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { StockMovement } from "@/models/StockMovement";

/**
 * Everything that moved stock, read as one dated list.
 *
 * Deliberately not a single table. Receiving and dispensing already keep their
 * own records - a GRN says what arrived, a bill says what left - and copying
 * every line into a second ledger would mean two sources that can disagree,
 * with no way to tell which one lied. So this reads the documents that already
 * exist and folds the new StockMovement entries in beside them.
 *
 * The cost is a merge in application code rather than one query. The benefit
 * is that the ledger is correct for stock that moved before it was written:
 * there is no backfill, no cut-over date, and no gap where a shop's history
 * used to be.
 *
 * Bounded by a date range for exactly that reason - this reads several
 * collections and sorts the result in memory, which is fine for a month of a
 * pharmacy's trading and is not fine for all of it.
 */

export interface LedgerEntry {
  id: string;
  at: Date;
  kind: MovementKind;
  direction: MovementDirection;
  medicineName: string;
  batchNumber: string;
  expiryDate: Date | null;
  unit: string;
  quantity: number;
  unitCost: number;
  /** quantity * unitCost. What the movement was worth at cost. */
  value: number;
  /** The lot's count after this happened. Null where the source cannot say. */
  balanceAfter: number | null;
  branchName: string;
  /** GRN number, bill number or transfer reference. */
  reference: string;
  /**
   * Who supplied the units, where that is a meaningful question.
   *
   * Only a delivery and a return to one have a supplier. A customer return, a
   * stock-take correction and a transfer between branches do not, and this is
   * blank for them rather than guessed at from the lot - the lot's supplier is
   * who sold it originally, which is not who moved it today.
   */
  supplier: string;
  /** Where to read the document behind it, when there is one. */
  referenceHref: string | null;
  reason: string;
  note: string;
  by: string;
}

export interface LedgerQuery {
  /**
   * Optional only so a report builder can pass one through unchanged.
   * `branchFilter` turns a missing scope into a filter that matches nothing,
   * so omitting it hides every pharmacy's stock rather than mixing them.
   */
  scope?: BranchScope;
  start: Date;
  end: Date;
  /**
   * Which way units moved. "both" is what the kind-specific screens want: an
   * adjustment goes whichever way the count was wrong, and a transfer is an
   * out and an in that belong on the same list.
   */
  direction?: MovementDirection | "both";
  /** Restrict to these kinds. Omit for everything moving that way. */
  kinds?: readonly MovementKind[];
  /** Matches medicine name, batch number or reference. */
  search?: string;
  /** Exact lot number. Narrower than `search`, which also hits names. */
  lot?: string;
  /** Supplier name. Only delivery rows carry one, so this hides the rest. */
  supplier?: string;
}

/**
 * Kinds this system writes itself, as opposed to the ones read back off a GRN
 * or a bill. A query for only these can skip the derived sources entirely.
 */
const LEDGER_ONLY_KINDS = new Set<MovementKind>([
  "adjustment",
  "damage",
  "transfer-in",
  "transfer-out",
]);

export interface LedgerPage {
  entries: LedgerEntry[];
  /** Totals over everything matched, not just the page shown. */
  totalUnits: number;
  totalValue: number;
  /** Units and value per kind, for the summary strip. */
  byKind: Array<{ kind: MovementKind; units: number; value: number; count: number }>;
}

function matches(entry: LedgerEntry, needle: string): boolean {
  if (!needle) return true;
  return (
    entry.medicineName.toLowerCase().includes(needle) ||
    entry.batchNumber.toLowerCase().includes(needle) ||
    entry.reference.toLowerCase().includes(needle)
  );
}

/**
 * Read the ledger for one direction over one date range.
 *
 * Returns every matching entry, newest first. Paging is left to the caller so
 * the totals above the table can be computed over the whole range rather than
 * over whichever fifty rows happen to be on screen - a summary that changes
 * when you turn the page is a summary nobody trusts.
 */
export async function readLedger(query: LedgerQuery): Promise<LedgerPage> {
  await connectDB();

  const { scope, start, end } = query;
  const direction = query.direction ?? "both";
  const needle = (query.search ?? "").trim().toLowerCase();
  const lotNeedle = (query.lot ?? "").trim().toLowerCase();
  const supplierName = (query.supplier ?? "").trim();
  const range = { $gte: start, $lt: end };

  // A screen asking only for adjustments or write-offs has no reason to read
  // every bill in the range to throw them all away again.
  const wants = (kind: MovementKind, way: MovementDirection) => {
    if (direction !== "both" && direction !== way) return false;
    return query.kinds ? query.kinds.includes(kind) : true;
  };
  const derivedNeeded =
    !query.kinds || query.kinds.some((kind) => !LEDGER_ONLY_KINDS.has(kind));

  const sources: Array<Promise<LedgerEntry[]>> = [movements(query, range)];

  if (derivedNeeded) {
    if (wants("purchase", "in")) sources.push(purchaseReceipts(scope, range));
    if (wants("sale-return", "in")) sources.push(customerReturns(scope, range));
    if (wants("sale", "out")) sources.push(dispensed(scope, range));
    if (wants("purchase-return", "out")) {
      sources.push(supplierReturns(scope, range));
    }
  }

  const all = (await Promise.all(sources)).flat();

  const entries = all
    .filter((entry) => (query.kinds ? query.kinds.includes(entry.kind) : true))
    .filter((entry) => direction === "both" || entry.direction === direction)
    .filter((entry) => matches(entry, needle))
    .filter((entry) =>
      lotNeedle ? entry.batchNumber.toLowerCase().includes(lotNeedle) : true,
    )
    /*
      An exact supplier match, not a substring: this comes from a dropdown of
      real supplier names, and "Lomus" quietly matching "Lomus Pharmaceuticals
      Nepal" as well would make the totals disagree with the filter.
    */
    .filter((entry) =>
      supplierName ? entry.supplier === supplierName : true,
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const byKind = new Map<MovementKind, { units: number; value: number; count: number }>();
  for (const entry of entries) {
    const row = byKind.get(entry.kind) ?? { units: 0, value: 0, count: 0 };
    row.units += entry.quantity;
    row.value += entry.value;
    row.count += 1;
    byKind.set(entry.kind, row);
  }

  return {
    entries,
    totalUnits: entries.reduce((sum, entry) => sum + entry.quantity, 0),
    totalValue: round2(entries.reduce((sum, entry) => sum + entry.value, 0)),
    byKind: [...byKind.entries()]
      .map(([kind, row]) => ({ kind, ...row, value: round2(row.value) }))
      .sort((a, b) => b.units - a.units),
  };
}

/** The entries this system writes itself: adjustments, write-offs, transfers. */
async function movements(
  query: LedgerQuery,
  range: Record<string, Date>,
): Promise<LedgerEntry[]> {
  const direction = query.direction ?? "both";

  const rows = await StockMovement.find({
    ...branchFilter(query.scope),
    ...(direction === "both" ? {} : { direction }),
    ...(query.kinds ? { kind: { $in: query.kinds } } : {}),
    createdAt: range,
  })
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    at: row.createdAt as unknown as Date,
    kind: row.kind as MovementKind,
    direction: row.direction as MovementDirection,
    medicineName: row.medicineName,
    batchNumber: row.batchNumber ?? "",
    expiryDate: (row.expiryDate as unknown as Date) ?? null,
    unit: row.unit ?? "unit",
    quantity: row.quantity,
    unitCost: row.unitCost ?? 0,
    value: row.value ?? 0,
    balanceAfter: row.balanceAfter,
    branchName: row.branchName ?? "",
    // A transfer's two halves share this, which is what lets somebody follow
    // units out of one branch and into the other.
    reference: row.transferRef || "",
    supplier: "",
    referenceHref: null,
    reason:
      row.reason ||
      (row.reasonCode
        ? (MOVEMENT_REASON_LABELS[row.reasonCode as MovementReason] ?? row.reasonCode)
        : ""),
    note: row.note ?? "",
    by: row.performedByName ?? "",
  }));
}

/** Units in from a posted GRN, read off the purchase itself. */
async function purchaseReceipts(
  scope: BranchScope | undefined,
  range: Record<string, Date>,
): Promise<LedgerEntry[]> {
  const rows = await Purchase.find({
    ...branchFilter(scope),
    status: "posted",
    postedAt: range,
  })
    .sort({ postedAt: -1 })
    .limit(1000)
    .lean();

  return rows.flatMap((purchase) =>
    purchase.items.map((item, index) => {
      // Free units arrive on the shelf exactly like billed ones; only the
      // invoice treats them differently, which is why the shelf figure is the
      // sum and the cost is the one already spread across both.
      const received = item.quantity + (item.freeQuantity ?? 0);
      const unitCost = item.effectiveUnitCost ?? item.costPrice ?? 0;

      return {
        id: `${String(purchase._id)}-${index}`,
        at: (purchase.postedAt as unknown as Date) ?? (purchase.createdAt as unknown as Date),
        kind: "purchase" as const,
        direction: "in" as const,
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        expiryDate: (item.expiryDate as unknown as Date) ?? null,
        unit: "unit",
        quantity: received,
        unitCost,
        value: round2(received * unitCost),
        balanceAfter: null,
        branchName: purchase.branchName ?? "",
        reference: purchase.grnNo,
        referenceHref: `/purchases/${String(purchase._id)}`,
        supplier: purchase.supplierName ?? "",
        reason: item.toppedUpExisting ? "Topped up an existing lot" : "",
        note: "",
        by: purchase.createdByName ?? "",
      };
    }),
  );
}

/** Units back on the shelf because a customer returned them. */
async function customerReturns(
  scope: BranchScope | undefined,
  range: Record<string, Date>,
): Promise<LedgerEntry[]> {
  const rows = await Sale.find({
    ...branchFilter(scope),
    "returns.returnedAt": range,
  })
    .select("billNo branchName returns")
    .limit(1000)
    .lean();

  const entries: LedgerEntry[] = [];

  for (const sale of rows) {
    for (const [entryIndex, entry] of (sale.returns ?? []).entries()) {
      const at = entry.returnedAt as unknown as Date;
      // The query matched the *bill*, so a bill with two returns brings both
      // back even when only one falls in the range. Filtered per entry here.
      if (!at || at < range.$gte! || at >= range.$lt!) continue;

      for (const [itemIndex, item] of entry.items.entries()) {
        entries.push({
          id: `${String(sale._id)}-r${entryIndex}-${itemIndex}`,
          at,
          kind: "sale-return",
          direction: "in",
          medicineName: item.medicineName,
          batchNumber: item.batchNumber,
          expiryDate: null,
          unit: "unit",
          quantity: item.quantity,
          unitCost: item.unitCost ?? 0,
          value: round2(item.quantity * (item.unitCost ?? 0)),
          balanceAfter: null,
          branchName: sale.branchName ?? "",
          reference: sale.billNo,
          referenceHref: `/sales/${String(sale._id)}`,
          // A customer brought these back; there is no supplier in it.
          supplier: "",
          reason: entry.reason ?? "",
          note: "",
          by: entry.returnedByName ?? "",
        });
      }
    }
  }

  return entries;
}

/** Units off the shelf on a bill, drawn FEFO from the lot that went out. */
async function dispensed(
  scope: BranchScope | undefined,
  range: Record<string, Date>,
): Promise<LedgerEntry[]> {
  const rows = await Sale.find({
    ...branchFilter(scope),
    createdAt: range,
    // A voided bill put its units back, so counting it as stock out would
    // report a day's dispensing that did not happen.
    voidedAt: null,
  })
    .select("billNo branchName soldByName createdAt items")
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();

  return rows.flatMap((sale) =>
    sale.items.map((item, index) => ({
      id: `${String(sale._id)}-${index}`,
      at: sale.createdAt as unknown as Date,
      kind: "sale" as const,
      direction: "out" as const,
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      expiryDate: (item.expiryDate as unknown as Date) ?? null,
      unit: item.unit ?? "unit",
      quantity: item.quantity,
      unitCost: item.unitCost ?? 0,
      value: round2(item.quantity * (item.unitCost ?? 0)),
      balanceAfter: null,
      branchName: sale.branchName ?? "",
      reference: sale.billNo,
      referenceHref: `/sales/${String(sale._id)}`,
      // Dispensing has a customer, not a supplier.
      supplier: "",
      reason: "",
      note: "",
      by: sale.soldByName ?? "",
    })),
  );
}

export { MOVEMENT_KIND_LABELS };

/**
 * Units off the shelf because they went back to the supplier.
 *
 * Read off the GRN, like the receipt entries above, for the same reason: the
 * debit note lives on the purchase and copying it into a second table would
 * give the ledger two sources that can disagree.
 */
async function supplierReturns(
  scope: BranchScope | undefined,
  range: Record<string, Date>,
): Promise<LedgerEntry[]> {
  const rows = await Purchase.find({
    ...branchFilter(scope),
    "returns.returnedAt": range,
  })
    .select("grnNo supplierName branchName returns")
    .limit(1000)
    .lean();

  const entries: LedgerEntry[] = [];

  for (const purchase of rows) {
    for (const [entryIndex, entry] of (purchase.returns ?? []).entries()) {
      const at = entry.returnedAt as unknown as Date;
      // Same per-entry filter as customer returns: the query matched the GRN,
      // so a delivery with two debit notes brings both back regardless of date.
      if (!at || at < range.$gte! || at >= range.$lt!) continue;

      for (const [itemIndex, item] of entry.items.entries()) {
        entries.push({
          id: `${String(purchase._id)}-pr${entryIndex}-${itemIndex}`,
          at,
          kind: "purchase-return",
          direction: "out",
          medicineName: item.medicineName,
          batchNumber: item.batchNumber,
          expiryDate: null,
          unit: "unit",
          quantity: item.quantity,
          unitCost: item.unitCost ?? 0,
          value: round2(item.quantity * (item.unitCost ?? 0)),
          balanceAfter: null,
          branchName: purchase.branchName ?? "",
          reference: purchase.grnNo,
          referenceHref: `/purchases/${String(purchase._id)}`,
          supplier: purchase.supplierName ?? "",
          reason: entry.reason ?? "",
          note: entry.creditNoteNo ? `Credit note ${entry.creditNoteNo}` : "",
          by: entry.returnedByName ?? "",
        });
      }
    }
  }

  return entries;
}
