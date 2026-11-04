import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { adToBs, formatBsIso } from "@/lib/bs-date";
import { localParts } from "@/lib/dates";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import {
  CONTROLLED_SCHEDULES,
  MEDICINE_SCHEDULE_LABELS,
  isControlledSchedule,
  type MedicineSchedule,
} from "@/lib/constants";
import { registerLines, type RegisterEvent } from "@/lib/controlled-register";
import { Batch } from "@/models/Batch";
import { Counter, findSequenceGaps } from "@/models/Counter";
import { Medicine } from "@/models/Medicine";
import { StockMovement } from "@/models/StockMovement";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Supplier } from "@/models/Supplier";
import { CbmsSync } from "@/models/CbmsSync";
import type { ReportDataset, ReportRow } from "@/lib/export/dataset";

/**
 * The books IRD asks a VAT-registered business to keep.
 *
 * Kept apart from lib/export/reports.ts because these follow the shape of the
 * VAT Rules annexes rather than what is useful to the shop: every bill in
 * number order, Bikram Sambat dates, the other party's PAN, and exempt,
 * taxable and VAT amounts in separate columns. The management reports next
 * door answer "how is the business doing?"; these answer "show me the books".
 */

export interface IrdReportRequest {
  from: Date;
  to: Date;
  rangeLabel: string;
  scope?: BranchScope;
}

/** IRD's threshold for reporting a customer or supplier by name and PAN. */
export const ANNUAL_PARTY_THRESHOLD = 100_000;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** "2082-04-15", the date column every IRD book leads with. */
export function bsDateOf(instant: Date | string | null | undefined): string {
  if (!instant) return "";
  try {
    const local = localParts(new Date(instant));
    return formatBsIso(adToBs(local.year, local.month, local.day));
  } catch {
    return "";
  }
}

/** Exempt and taxable portions of a bill, read safely from older documents. */
function saleSplit(sale: { taxableAmount: number; exemptAmount?: number | null }) {
  const exempt = round2(sale.exemptAmount ?? 0);
  return { exempt, taxable: round2(sale.taxableAmount - exempt) };
}

/**
 * A purchase has one VAT rate over the whole delivery, so it is either all
 * taxable or, when the supplier charged no VAT, all exempt.
 */
function purchaseSplit(purchase: { taxableAmount: number; vatAmount: number }) {
  const exempt = purchase.vatAmount > 0 ? 0 : round2(purchase.taxableAmount);
  return { exempt, taxable: round2(purchase.taxableAmount - exempt) };
}

/** Debit notes recorded before taxable/VAT were stored are split back out of the total. */
function purchaseReturnSplit(
  entry: { taxableAmount?: number | null; vatAmount?: number | null; totalAmount: number },
  vatRate: number,
) {
  if (entry.taxableAmount != null && entry.vatAmount != null) {
    return { taxable: round2(entry.taxableAmount), vat: round2(entry.vatAmount) };
  }
  const taxable = round2(entry.totalAmount / (1 + (vatRate || 0)));
  return { taxable, vat: round2(entry.totalAmount - taxable) };
}

async function supplierPans(ids: readonly unknown[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map(String))].filter(Types.ObjectId.isValid);
  if (unique.length === 0) return new Map();
  const suppliers = await Supplier.find({ _id: { $in: unique } })
    .select("_id panNo")
    .lean();
  return new Map(suppliers.map((s) => [String(s._id), s.panNo ?? ""]));
}

// ---------------------------------------------------------------------------
// Invoice register and cancelled invoices
// ---------------------------------------------------------------------------

/**
 * Every bill issued in the range, in number order, cancelled ones included.
 *
 * A cancelled bill keeps its row - its number was issued, and a gap in the
 * sequence is the first thing an auditor looks for. Its money is moved to the
 * "Cancelled value" column so the live totals are not inflated by it.
 */
export async function invoiceRegister({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  const sales = await Sale.find({ createdAt: { $gte: from, $lt: to }, ...branchFilter(scope) })
    .sort({ createdAt: 1, billSeq: 1 })
    .lean();

  const cancelled = sales.filter((sale) => sale.voidedAt).length;

  return {
    title: "Invoice Register",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Invoices issued", value: String(sales.length) },
      { label: "Cancelled", value: String(cancelled) },
    ],
    columns: [
      { key: "billNo", header: "Invoice no", type: "text", width: 20 },
      { key: "dateBs", header: "Date (BS)", type: "text", width: 11 },
      { key: "date", header: "Date (AD)", type: "date" },
      { key: "customer", header: "Buyer", type: "text", width: 22 },
      { key: "pan", header: "Buyer PAN", type: "text", width: 12 },
      { key: "exempt", header: "Exempt", type: "money", total: true },
      { key: "taxable", header: "Taxable", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "total", header: "Total", type: "money", total: true },
      { key: "status", header: "Status", type: "text" },
      { key: "cancelledValue", header: "Cancelled value", type: "money", total: true },
      { key: "printed", header: "Prints", type: "integer" },
    ],
    rows: sales.map((sale): ReportRow => {
      const voided = Boolean(sale.voidedAt);
      const { exempt, taxable } = saleSplit(sale);
      return {
        billNo: sale.billNo,
        dateBs: bsDateOf(sale.createdAt as unknown as Date),
        date: new Date(sale.createdAt as unknown as Date),
        customer: sale.customerName || "Walk-in",
        pan: sale.customerPan ?? "",
        exempt: voided ? 0 : exempt,
        taxable: voided ? 0 : taxable,
        vat: voided ? 0 : sale.vatAmount,
        total: voided ? 0 : sale.totalAmount,
        status: voided ? "Cancelled" : (sale.returnedUnits ?? 0) > 0 ? "Credit note issued" : "Issued",
        cancelledValue: voided ? sale.totalAmount : 0,
        printed: (sale.printedAt ? 1 : 0) + (sale.reprintCount ?? 0),
      };
    }),
    note: "Every invoice issued in the period, in number order. Cancelled invoices keep their row; their value is shown under 'Cancelled value' only. Returns are listed in the credit note book.",
  };
}

export async function cancelledInvoices({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  // By the date the bill was raised, so the report lines up with the register.
  const sales = await Sale.find({
    createdAt: { $gte: from, $lt: to },
    voidedAt: { $ne: null },
    ...branchFilter(scope),
  })
    .sort({ createdAt: 1, billSeq: 1 })
    .lean();

  return {
    title: "Cancelled Invoices",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Cancelled", value: String(sales.length) }],
    columns: [
      { key: "billNo", header: "Invoice no", type: "text", width: 20 },
      { key: "dateBs", header: "Issued (BS)", type: "text", width: 11 },
      { key: "issued", header: "Issued (AD)", type: "date" },
      { key: "customer", header: "Buyer", type: "text", width: 22 },
      { key: "pan", header: "Buyer PAN", type: "text", width: 12 },
      { key: "total", header: "Value", type: "money", total: true },
      { key: "cancelledBs", header: "Cancelled (BS)", type: "text", width: 11 },
      { key: "cancelledBy", header: "Cancelled by", type: "text", width: 18 },
      { key: "reason", header: "Reason", type: "text", width: 30 },
    ],
    rows: sales.map((sale) => ({
      billNo: sale.billNo,
      dateBs: bsDateOf(sale.createdAt as unknown as Date),
      issued: new Date(sale.createdAt as unknown as Date),
      customer: sale.customerName || "Walk-in",
      pan: sale.customerPan ?? "",
      total: sale.totalAmount,
      cancelledBs: bsDateOf(sale.voidedAt),
      cancelledBy: sale.voidedByName ?? "",
      reason: sale.voidReason ?? "",
    })),
    note: "A cancelled invoice is never deleted. It stays on file under its number and can be reprinted, marked as cancelled.",
  };
}

// ---------------------------------------------------------------------------
// Sales and purchase books
// ---------------------------------------------------------------------------

export async function salesBook({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  // A bill counts in the period it was issued, unless it was cancelled within
  // that same period. Cancelled later, it stays here and is reversed in the
  // period of the cancellation, so a month already filed reads the same forever.
  const [sales, cancelled] = await Promise.all([
    Sale.find({
      createdAt: { $gte: from, $lt: to },
      $or: [{ voidedAt: null }, { voidedAt: { $gte: to } }],
      ...branchFilter(scope),
    })
      .sort({ createdAt: 1, billSeq: 1 })
      .lean(),
    Sale.find({
      createdAt: { $lt: from },
      voidedAt: { $gte: from, $lt: to },
      ...branchFilter(scope),
    })
      .sort({ voidedAt: 1, billSeq: 1 })
      .lean(),
  ]);

  return {
    title: "Sales Book",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Invoices", value: String(sales.length) },
      ...(cancelled.length > 0
        ? [{ label: "Reversed from earlier periods", value: String(cancelled.length) }]
        : []),
    ],
    columns: [
      { key: "dateBs", header: "Date (BS)", type: "text", width: 11 },
      { key: "billNo", header: "Invoice no", type: "text", width: 20 },
      { key: "customer", header: "Buyer's name", type: "text", width: 24 },
      { key: "pan", header: "Buyer's PAN", type: "text", width: 12 },
      { key: "quantity", header: "Qty", type: "integer", total: true },
      { key: "total", header: "Total sales", type: "money", total: true },
      { key: "exempt", header: "Non-taxable sales", type: "money", total: true },
      { key: "export", header: "Export sales", type: "money", total: true },
      { key: "taxable", header: "Taxable amount", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
    ],
    rows: [
      ...sales.map((sale) => {
        const { exempt, taxable } = saleSplit(sale);
        return {
          dateBs: bsDateOf(sale.createdAt as unknown as Date),
          billNo: sale.billNo,
          customer: sale.customerName || "Walk-in",
          pan: sale.customerPan ?? "",
          quantity: sale.items.reduce((sum, item) => sum + item.quantity, 0),
          total: sale.totalAmount,
          exempt,
          // A retail pharmacy does not export; the column is there because the
          // book's layout has it.
          export: 0,
          taxable,
          vat: sale.vatAmount,
        };
      }),
      // Only what was still on the bill: its returns were already credited.
      ...cancelled.map((sale) => {
        const { exempt, taxable } = saleSplit({
          taxableAmount: sale.taxableAmount - (sale.returnedTaxable ?? 0),
          exemptAmount: (sale.exemptAmount ?? 0) - (sale.returnedExempt ?? 0),
        });
        return {
          dateBs: bsDateOf(sale.voidedAt as unknown as Date),
          billNo: sale.billNo,
          customer: `Cancelled: ${sale.customerName || "Walk-in"}`,
          pan: sale.customerPan ?? "",
          quantity: -(sale.items.reduce((sum, item) => sum + item.quantity, 0) - (sale.returnedUnits ?? 0)),
          total: -round2(sale.totalAmount - (sale.returnedTotal ?? 0)),
          exempt: -exempt,
          export: 0,
          taxable: -taxable,
          vat: -round2(sale.vatAmount - (sale.returnedVat ?? 0)),
        };
      }),
    ],
    note: "Invoices at the value issued, in the period issued. A bill cancelled in a later period stays in its own period and is reversed, as a negative line, in the period it was cancelled. Returns are in the credit note book.",
  };
}

export async function purchaseBook({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  const purchases = await Purchase.find({
    status: "posted",
    receivedDate: { $gte: from, $lt: to },
    ...branchFilter(scope),
  })
    .sort({ receivedDate: 1, grnSeq: 1 })
    .lean();
  const pans = await supplierPans(purchases.map((p) => p.supplierId));

  return {
    title: "Purchase Book",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Purchase invoices", value: String(purchases.length) }],
    columns: [
      { key: "dateBs", header: "Date (BS)", type: "text", width: 11 },
      { key: "invoiceNo", header: "Supplier invoice", type: "text", width: 16 },
      { key: "grnNo", header: "GRN", type: "text", width: 12 },
      { key: "supplier", header: "Supplier's name", type: "text", width: 24 },
      { key: "pan", header: "Supplier's PAN", type: "text", width: 12 },
      { key: "total", header: "Total purchase", type: "money", total: true },
      { key: "exempt", header: "Non-taxable purchase", type: "money", total: true },
      { key: "taxable", header: "Taxable purchase", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
    ],
    rows: purchases.map((purchase) => {
      const { exempt, taxable } = purchaseSplit(purchase);
      return {
        dateBs: bsDateOf(purchase.invoiceDate ?? purchase.receivedDate),
        invoiceNo: purchase.invoiceNo ?? "",
        grnNo: purchase.grnNo,
        supplier: purchase.supplierName,
        pan: pans.get(String(purchase.supplierId)) ?? "",
        total: purchase.totalAmount,
        exempt,
        taxable,
        vat: purchase.vatAmount,
      };
    }),
    note: "Posted deliveries only. A delivery on which the supplier charged no VAT is listed as non-taxable. Returns to suppliers are in the debit note book.",
  };
}

// ---------------------------------------------------------------------------
// Credit and debit note books
// ---------------------------------------------------------------------------

export async function creditNoteBook({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  const sales = await Sale.find({
    ...branchFilter(scope),
    returns: { $elemMatch: { returnedAt: { $gte: from, $lt: to } } },
  })
    .select("billNo customerName customerPan returns")
    .lean();

  const entries = sales.flatMap((sale) =>
    (sale.returns ?? []).map((entry, index) => ({ sale, entry, index })),
  )
    .filter(({ entry }) => {
      const at = new Date(entry.returnedAt).getTime();
      return at >= from.getTime() && at < to.getTime();
    })
    .sort((a, b) => new Date(a.entry.returnedAt).getTime() - new Date(b.entry.returnedAt).getTime());

  return {
    title: "Credit Note Book",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Credit notes", value: String(entries.length) }],
    columns: [
      { key: "dateBs", header: "Date (BS)", type: "text", width: 11 },
      { key: "noteNo", header: "Credit note no", type: "text", width: 20 },
      { key: "billNo", header: "Against invoice", type: "text", width: 20 },
      { key: "customer", header: "Buyer's name", type: "text", width: 22 },
      { key: "pan", header: "Buyer's PAN", type: "text", width: 12 },
      { key: "total", header: "Total", type: "money", total: true },
      { key: "exempt", header: "Non-taxable", type: "money", total: true },
      { key: "taxable", header: "Taxable", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "reason", header: "Reason", type: "text", width: 26 },
    ],
    rows: entries.map(({ sale, entry, index }) => {
      const exempt = round2(entry.exemptAmount ?? 0);
      return {
        dateBs: bsDateOf(entry.returnedAt),
        noteNo: entry.creditNoteNo
          ? entry.creditNoteNo
          : `${sale.billNo}/R${index + 1}`,
        billNo: sale.billNo,
        customer: sale.customerName || "Walk-in",
        pan: sale.customerPan ?? "",
        total: entry.totalAmount,
        exempt,
        taxable: round2(entry.taxableAmount - exempt),
        vat: entry.vatAmount,
        reason: entry.reason ?? "",
      };
    }),
    note: "Sales returns, each issued against its original invoice. Returns recorded before credit notes were numbered show the invoice number with /R.",
  };
}

export async function debitNoteBook({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  const purchases = await Purchase.find({
    ...branchFilter(scope),
    returns: { $elemMatch: { returnedAt: { $gte: from, $lt: to } } },
  })
    .select("grnNo invoiceNo supplierId supplierName vatRate vatAmount taxableAmount returns")
    .lean();
  const pans = await supplierPans(purchases.map((p) => p.supplierId));

  const entries = purchases.flatMap((purchase) =>
    (purchase.returns ?? []).map((entry, index) => ({ purchase, entry, index })),
  )
    .filter(({ entry }) => {
      const at = new Date(entry.returnedAt).getTime();
      return at >= from.getTime() && at < to.getTime();
    })
    .sort((a, b) => new Date(a.entry.returnedAt).getTime() - new Date(b.entry.returnedAt).getTime());

  return {
    title: "Debit Note Book",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Debit notes", value: String(entries.length) }],
    columns: [
      { key: "dateBs", header: "Date (BS)", type: "text", width: 11 },
      { key: "noteNo", header: "Debit note no", type: "text", width: 20 },
      { key: "invoiceNo", header: "Against invoice", type: "text", width: 16 },
      { key: "grnNo", header: "GRN", type: "text", width: 12 },
      { key: "supplier", header: "Supplier's name", type: "text", width: 22 },
      { key: "pan", header: "Supplier's PAN", type: "text", width: 12 },
      { key: "total", header: "Total", type: "money", total: true },
      { key: "exempt", header: "Non-taxable", type: "money", total: true },
      { key: "taxable", header: "Taxable", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "supplierNote", header: "Supplier's credit note", type: "text", width: 16 },
    ],
    rows: entries.map(({ purchase, entry, index }) => {
      const split = purchaseReturnSplit(entry, purchase.vatRate ?? 0);
      // A return follows the delivery: what was bought with no VAT goes back the
      // same way, or the book shows taxable purchases that never happened.
      const exempt = purchaseSplit(purchase).exempt > 0;
      return {
        dateBs: bsDateOf(entry.returnedAt),
        noteNo: entry.debitNoteNo
          ? entry.debitNoteNo
          : `${purchase.grnNo}/R${index + 1}`,
        invoiceNo: purchase.invoiceNo ?? "",
        grnNo: purchase.grnNo,
        supplier: purchase.supplierName,
        pan: pans.get(String(purchase.supplierId)) ?? "",
        total: entry.totalAmount,
        exempt: exempt ? split.taxable : 0,
        taxable: exempt ? 0 : split.taxable,
        vat: split.vat,
        supplierNote: entry.creditNoteNo ?? "",
      };
    }),
    note: "Returns to suppliers. Returns recorded before debit notes were numbered show the GRN with /R.",
  };
}

// ---------------------------------------------------------------------------
// Parties above NPR 1 lakh
// ---------------------------------------------------------------------------

interface PartyTotal {
  kind: "Customer" | "Supplier";
  name: string;
  pan: string;
  documents: number;
  taxable: number;
  vat: number;
  total: number;
}

/**
 * Customers and suppliers whose dealings in the period exceed NPR 1 lakh.
 *
 * Net of returns: a bill that came back is not a transaction with that party.
 * Walk-in sales with no name cannot be attributed to anyone and are left out.
 */
export async function partiesAboveLakh({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();

  const [sales, purchases] = await Promise.all([
    Sale.find({ createdAt: { $gte: from, $lt: to }, voidedAt: null, ...branchFilter(scope) })
      .select("customerId customerName customerPan taxableAmount vatAmount totalAmount returnedTaxable returnedVat returnedTotal")
      .lean(),
    Purchase.find({ status: "posted", receivedDate: { $gte: from, $lt: to }, ...branchFilter(scope) })
      .select("supplierId supplierName taxableAmount vatAmount totalAmount returnedTotal vatRate")
      .lean(),
  ]);
  const pans = await supplierPans(purchases.map((p) => p.supplierId));

  const parties = new Map<string, PartyTotal>();
  const add = (key: string, seed: Omit<PartyTotal, "documents" | "taxable" | "vat" | "total">, taxable: number, vat: number, total: number) => {
    const party = parties.get(key) ?? { ...seed, documents: 0, taxable: 0, vat: 0, total: 0 };
    if (!party.pan && seed.pan) party.pan = seed.pan;
    party.documents += 1;
    party.taxable = round2(party.taxable + taxable);
    party.vat = round2(party.vat + vat);
    party.total = round2(party.total + total);
    parties.set(key, party);
  };

  for (const sale of sales) {
    const name = sale.customerName?.trim() ?? "";
    if (!sale.customerId && !name) continue;
    const key = sale.customerId
      ? `c:${String(sale.customerId)}`
      : `c:${name.toLowerCase()}|${sale.customerPan ?? ""}`;
    add(
      key,
      { kind: "Customer", name: name || "Customer", pan: sale.customerPan ?? "" },
      sale.taxableAmount - (sale.returnedTaxable ?? 0),
      sale.vatAmount - (sale.returnedVat ?? 0),
      sale.totalAmount - (sale.returnedTotal ?? 0),
    );
  }

  for (const purchase of purchases) {
    const returned = purchase.returnedTotal ?? 0;
    const rate = purchase.vatRate ?? 0;
    const returnedTaxable = round2(returned / (1 + rate));
    add(
      `s:${String(purchase.supplierId)}`,
      { kind: "Supplier", name: purchase.supplierName, pan: pans.get(String(purchase.supplierId)) ?? "" },
      purchase.taxableAmount - returnedTaxable,
      purchase.vatAmount - (returned - returnedTaxable),
      purchase.totalAmount - returned,
    );
  }

  const rows = [...parties.values()]
    .filter((party) => party.total > ANNUAL_PARTY_THRESHOLD)
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.total - a.total);

  return {
    title: "Parties Above NPR 1 Lakh",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Customers", value: String(rows.filter((r) => r.kind === "Customer").length) },
      { label: "Suppliers", value: String(rows.filter((r) => r.kind === "Supplier").length) },
    ],
    columns: [
      { key: "kind", header: "Type", type: "text", width: 10 },
      { key: "name", header: "Name", type: "text", width: 28 },
      { key: "pan", header: "PAN", type: "text", width: 12 },
      { key: "documents", header: "Invoices", type: "integer" },
      { key: "taxable", header: "Amount excl. VAT", type: "money" },
      { key: "vat", header: "VAT", type: "money" },
      { key: "total", header: "Total", type: "money" },
    ],
    rows: rows.map((party) => ({ ...party })),
    note: "Run this over a full fiscal year (Shrawan to Ashadh) for the annual return. Amounts are net of returns. Unnamed walk-in sales are excluded.",
  };
}

// ---------------------------------------------------------------------------
// VAT return
// ---------------------------------------------------------------------------

/**
 * The figures a monthly VAT return (Annex 10) is filled from.
 *
 * Laid out as the return reads - sales, then purchases, then the difference -
 * rather than as a ledger, so the numbers can be typed straight across.
 */
export async function vatReturn({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  const [sales, credits, purchases, debits] = await Promise.all([
    salesBook({ from, to, rangeLabel, scope }),
    creditNoteBook({ from, to, rangeLabel, scope }),
    purchaseBook({ from, to, rangeLabel, scope }),
    debitNoteBook({ from, to, rangeLabel, scope }),
  ]);

  const sum = (dataset: ReportDataset, key: string) =>
    round2(
      dataset.rows.reduce((total, row) => {
        const value = row[key];
        return total + (typeof value === "number" ? value : 0);
      }, 0),
    );

  const salesTaxable = round2(sum(sales, "taxable") - sum(credits, "taxable"));
  const salesExempt = round2(sum(sales, "exempt") - sum(credits, "exempt"));
  const outputVat = round2(sum(sales, "vat") - sum(credits, "vat"));
  const purchaseTaxable = round2(sum(purchases, "taxable") - sum(debits, "taxable"));
  const purchaseExempt = round2(sum(purchases, "exempt") - sum(debits, "exempt"));
  const inputVat = round2(sum(purchases, "vat") - sum(debits, "vat"));
  const net = round2(outputVat - inputVat);

  const line = (section: string, item: string, value: number | null, vat: number | null): ReportRow => ({
    section,
    item,
    value,
    vat,
  });

  return {
    title: "VAT Return",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Output VAT", value: outputVat.toFixed(2) },
      { label: "Input VAT", value: inputVat.toFixed(2) },
      { label: net >= 0 ? "VAT payable" : "VAT credit carried forward", value: Math.abs(net).toFixed(2) },
    ],
    columns: [
      { key: "section", header: "Section", type: "text", width: 12 },
      { key: "item", header: "Particulars", type: "text", width: 40 },
      { key: "value", header: "Value", type: "money" },
      { key: "vat", header: "VAT", type: "money" },
    ],
    rows: [
      line("Sales", "Taxable sales", sum(sales, "taxable"), sum(sales, "vat")),
      line("Sales", "Less: sales returns (credit notes)", -sum(credits, "taxable"), -sum(credits, "vat")),
      line("Sales", "Net taxable sales", salesTaxable, outputVat),
      line("Sales", "Exempt sales (net of returns)", salesExempt, null),
      line("Sales", "Export sales", 0, null),
      line("Purchases", "Taxable purchases", sum(purchases, "taxable"), sum(purchases, "vat")),
      line("Purchases", "Less: purchase returns (debit notes)", -sum(debits, "taxable"), -sum(debits, "vat")),
      line("Purchases", "Net taxable purchases", purchaseTaxable, inputVat),
      line("Purchases", "Exempt purchases (net of returns)", purchaseExempt, null),
      line("Purchases", "Taxable imports", 0, 0),
      line("Result", net >= 0 ? "VAT payable for the period" : "VAT credit to carry forward", null, Math.abs(net)),
    ],
    note: "Prepared from the sales, purchase, credit note and debit note books for the same period. Check against your accountant's working before filing.",
  };
}

// ---------------------------------------------------------------------------
// CBMS: what IRD has not accepted yet
// ---------------------------------------------------------------------------

const CBMS_KIND_LABELS: Record<string, string> = {
  bill: "Invoice",
  return: "Credit note",
  cancel: "Cancellation",
};

const CBMS_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting",
  failed: "Failed - will retry",
  disabled: "Not sent - CBMS off",
  synced: "Accepted",
};

/**
 * Every invoice, credit note and cancellation IRD has not accepted, issued in
 * the period. Whatever is on this list is still owed to CBMS.
 */
export async function cbmsUnsynced({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();
  const pharmacyId = scope?.pharmacyId;

  const rows = pharmacyId
    ? await CbmsSync.find({
        pharmacyId,
        status: { $ne: "synced" },
        issuedAt: { $gte: from, $lt: to },
      })
        .sort({ issuedAt: 1 })
        .lean()
    : [];

  return {
    title: "Bills Not Yet in CBMS",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Outstanding", value: String(rows.length) }],
    columns: [
      { key: "documentNo", header: "Document", type: "text", width: 22 },
      { key: "kind", header: "Type", type: "text", width: 12 },
      { key: "dateBs", header: "Issued (BS)", type: "text", width: 11 },
      { key: "issued", header: "Issued (AD)", type: "date" },
      { key: "status", header: "Status", type: "text", width: 18 },
      { key: "attempts", header: "Attempts", type: "integer" },
      { key: "lastAttempt", header: "Last attempt", type: "date" },
      { key: "response", header: "IRD's answer", type: "text", width: 36 },
    ],
    rows: rows.map((row) => ({
      documentNo: row.documentNo,
      kind: CBMS_KIND_LABELS[row.kind] ?? row.kind,
      dateBs: bsDateOf(row.issuedAt),
      issued: new Date(row.issuedAt),
      status: CBMS_STATUS_LABELS[row.status] ?? row.status,
      attempts: row.attempts,
      lastAttempt: row.lastAttemptAt ? new Date(row.lastAttemptAt) : null,
      response: row.responseMessage ?? "",
    })),
    note: "Failed rows are retried automatically with increasing gaps. Bills raised while CBMS is switched off are held here until Send now pushes them.",
  };
}

// ---------------------------------------------------------------------------
// Bill number gaps
// ---------------------------------------------------------------------------

/** The number at the end of "CN-2083-84-000012", or null for one from before numbering. */
function noteSeq(noteNo: string | null | undefined, prefix: string, year: string): number | null {
  if (!noteNo?.startsWith(`${prefix}-${year}-`)) return null;
  const seq = Number(noteNo.slice(noteNo.lastIndexOf("-") + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

/**
 * Numbers missing from the bill, credit note and debit note series of each fiscal
 * year the period touches.
 *
 * Always the whole year across every branch, whatever the screen is scoped to:
 * the series belongs to the pharmacy, so one branch's view of it is full of
 * numbers that are not missing at all, only billed next door.
 */
export async function billNumberGaps({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();
  const pharmacyId = scope?.pharmacyId;

  const years: string[] = pharmacyId
    ? (
        await Sale.distinct("fiscalYear", {
          pharmacyId,
          createdAt: { $gte: from, $lt: to },
        })
      ).filter((year): year is string => Boolean(year))
    : [];

  const rows: ReportRow[] = [];
  let checked = 0;
  for (const year of years.sort()) {
    const [sales, withCredit, withDebit, counters] = await Promise.all([
      Sale.find({ pharmacyId, fiscalYear: year }).select("billSeq").lean(),
      Sale.find({ pharmacyId, "returns.creditNoteNo": { $regex: `^CN-${year}-` } })
        .select("returns.creditNoteNo")
        .lean(),
      Purchase.find({ pharmacyId, "returns.debitNoteNo": { $regex: `^DN-${year}-` } })
        .select("returns.debitNoteNo")
        .lean(),
      Counter.find({
        _id: {
          $in: ["sale", "credit-note", "debit-note"].map((name) => `${String(pharmacyId)}:${name}:${year}`),
        },
      }).lean(),
    ]);
    const issued = (name: string) =>
      counters.find((counter) => counter._id === `${String(pharmacyId)}:${name}:${year}`)?.seq ?? 0;
    const known = (seqs: Array<number | null>) => seqs.filter((seq): seq is number => seq != null && seq > 0);

    const series = [
      { label: "Bills", seqs: known(sales.map((sale) => sale.billSeq ?? null)), counter: issued("sale") },
      {
        label: "Credit notes",
        seqs: known(withCredit.flatMap((sale) => (sale.returns ?? []).map((entry) => noteSeq(entry.creditNoteNo, "CN", year)))),
        counter: issued("credit-note"),
      },
      {
        label: "Debit notes",
        seqs: known(withDebit.flatMap((purchase) => (purchase.returns ?? []).map((entry) => noteSeq(entry.debitNoteNo, "DN", year)))),
        counter: issued("debit-note"),
      },
    ];
    for (const { label, seqs, counter } of series) {
      checked += seqs.length;
      for (const gap of findSequenceGaps(seqs, counter)) {
        rows.push({ series: label, fiscalYear: year, from: gap.from, to: gap.to, count: gap.to - gap.from + 1 });
      }
    }
  }

  return {
    title: "Document Number Gaps",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Documents checked", value: String(checked) },
      { label: "Numbers missing", value: String(rows.reduce((sum, row) => sum + Number(row.count), 0)) },
    ],
    columns: [
      { key: "series", header: "Series", type: "text", width: 14 },
      { key: "fiscalYear", header: "Fiscal year", type: "text", width: 12 },
      { key: "from", header: "First missing", type: "integer" },
      { key: "to", header: "Last missing", type: "integer" },
      { key: "count", header: "Numbers", type: "integer", total: true },
    ],
    rows,
    note: "Checks bills, credit notes and debit notes across every branch, for each fiscal year the period touches. An empty table means every series is unbroken.",
  };
}

// ---------------------------------------------------------------------------
// Materialized view
// ---------------------------------------------------------------------------

/**
 * The one-row-per-bill view IRD's e-billing procedure asks approved software to
 * expose, using its column names. Cancelled bills stay, flagged inactive.
 */
export async function materializedView({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();
  const sales = await Sale.find({ createdAt: { $gte: from, $lt: to }, ...branchFilter(scope) })
    .sort({ createdAt: 1, billSeq: 1 })
    .select(
      "fiscalYear billNo customerName customerPan createdAt subtotal discount taxableAmount exemptAmount vatAmount totalAmount cbmsStatus cbmsSyncedAt printedAt printedByName soldByName voidedAt",
    )
    .lean();

  return {
    title: "Materialized View",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Bills", value: String(sales.length) }],
    columns: [
      { key: "fiscalYear", header: "Fiscal_Year", type: "text", width: 10 },
      { key: "billNo", header: "Bill_no", type: "text", width: 20 },
      { key: "customer", header: "Customer_name", type: "text", width: 20 },
      { key: "pan", header: "Customer_pan", type: "text", width: 12 },
      { key: "date", header: "Bill_Date", type: "text", width: 11 },
      { key: "amount", header: "Amount", type: "money", total: true },
      { key: "discount", header: "Discount", type: "money", total: true },
      { key: "exempt", header: "Tax_Exempt", type: "money", total: true },
      { key: "taxable", header: "Taxable_Amount", type: "money", total: true },
      { key: "tax", header: "Tax_Amount", type: "money", total: true },
      { key: "total", header: "Total_Amount", type: "money", total: true },
      { key: "synced", header: "Sync_with_IRD", type: "text" },
      { key: "printed", header: "IS_Bill_Printed", type: "text" },
      { key: "active", header: "IS_Bill_Active", type: "text" },
      { key: "printedAt", header: "Printed_Time", type: "date" },
      { key: "enteredBy", header: "Entered_By", type: "text", width: 16 },
      { key: "printedBy", header: "Printed_By", type: "text", width: 16 },
      { key: "realtime", header: "Is_realtime", type: "text" },
    ],
    rows: sales.map((sale): ReportRow => {
      const { exempt, taxable } = saleSplit(sale);
      const createdAt = new Date(sale.createdAt as unknown as Date);
      const syncedAt = sale.cbmsSyncedAt ? new Date(sale.cbmsSyncedAt as unknown as Date) : null;
      const yesNo = (value: boolean) => (value ? "Yes" : "No");
      return {
        fiscalYear: sale.fiscalYear ?? "",
        billNo: sale.billNo,
        customer: sale.customerName ?? "",
        pan: sale.customerPan ?? "",
        date: bsDateOf(createdAt),
        amount: sale.subtotal,
        discount: sale.discount,
        exempt,
        taxable,
        tax: sale.vatAmount,
        total: sale.totalAmount,
        synced: yesNo(sale.cbmsStatus === "synced"),
        printed: yesNo(Boolean(sale.printedAt)),
        active: yesNo(!sale.voidedAt),
        printedAt: sale.printedAt ? new Date(sale.printedAt as unknown as Date) : null,
        enteredBy: sale.soldByName ?? "",
        printedBy: sale.printedByName ?? "",
        realtime: yesNo(Boolean(syncedAt && syncedAt.getTime() - createdAt.getTime() < 5 * 60_000)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Narcotic and psychotropic register
// ---------------------------------------------------------------------------

/**
 * DDA's retailer's record for narcotic and psychotropic medicines.
 *
 * The columns are the ones on DDA's form, in its order, one running record per
 * drug. The signature columns print with the name filled in and room to sign.
 * Read straight from the source documents without the ledger's row caps, because
 * a legal register must never be quietly cut short.
 */
export async function controlledRegister({
  from,
  to,
  rangeLabel,
  scope,
}: IrdReportRequest): Promise<ReportDataset> {
  await connectDB();
  const pharmacyId = scope?.pharmacyId;

  const since = { $gte: from };
  const scoped = branchFilter(scope);

  // What was controlled when it was sold stays on the record, even if the drug
  // has since been reclassified. The schedule frozen on the bill decides that.
  const soldControlled = pharmacyId
    ? await Sale.find({
        ...scoped,
        "items.schedule": { $in: CONTROLLED_SCHEDULES },
        $or: [{ createdAt: since }, { voidedAt: since }, { "returns.returnedAt": since }],
      })
        .select("items.medicineId items.medicineName items.schedule")
        .lean()
    : [];
  const soldIds = new Map<string, unknown>();
  const soldNames = new Map<string, string>();
  for (const sale of soldControlled) {
    for (const item of sale.items) {
      if (!isControlledSchedule(item.schedule)) continue;
      soldIds.set(String(item.medicineId), item.medicineId);
      soldNames.set(String(item.medicineId), item.medicineName);
    }
  }

  const medicines = pharmacyId
    ? await Medicine.find({
        pharmacyId,
        $or: [{ schedule: { $in: CONTROLLED_SCHEDULES } }, { _id: { $in: [...soldIds.values()] } }],
      })
        .select("name genericName manufacturer schedule")
        .sort({ name: 1 })
        .lean()
    : [];
  const wanted = new Set([...medicines.map((medicine) => String(medicine._id)), ...soldIds.keys()]);
  const ids = [...new Set([...medicines.map((medicine) => medicine._id), ...soldIds.values()])];

  const [sales, purchases, movements, stock] = ids.length
    ? await Promise.all([
        Sale.find({
          ...scoped,
          "items.medicineId": { $in: ids },
          $or: [{ createdAt: since }, { voidedAt: since }, { "returns.returnedAt": since }],
        }).lean(),
        Purchase.find({
          ...scoped,
          status: "posted",
          "items.medicineId": { $in: ids },
          $or: [{ postedAt: since }, { "returns.returnedAt": since }],
        }).lean(),
        StockMovement.find({ ...scoped, medicineId: { $in: ids }, createdAt: since }).lean(),
        Batch.aggregate<{ _id: unknown; quantity: number }>([
          { $match: { ...scoped, medicineId: { $in: ids } } },
          { $group: { _id: "$medicineId", quantity: { $sum: "$quantity" } } },
        ]),
      ])
    : [[], [], [], []];

  const batchIds = sales.flatMap((sale) => sale.items.map((item) => item.batchId));
  const batches = batchIds.length
    ? await Batch.find({ _id: { $in: batchIds } }).select("mfgDate").lean()
    : [];
  const mfgDates = new Map(batches.map((batch) => [String(batch._id), batch.mfgDate]));

  const lotLabel = (batch: string, mfg: unknown, expiry: unknown) =>
    [
      batch,
      mfg ? `Mfg ${bsDateOf(mfg as Date)}` : "",
      expiry ? `Exp ${bsDateOf(expiry as Date)}` : "",
    ]
      .filter(Boolean)
      .join(" / ");

  const events: RegisterEvent[] = [];

  for (const sale of sales) {
    const billNo = sale.billNo;
    const createdAt = new Date(sale.createdAt as unknown as Date);
    const record = sale.controlled;
    const patient = record?.patientName ?? (sale.customerName || "");
    const prescribedBy = record
      ? `${record.prescriberName} (NMC ${record.prescriberNmcNo})`
      : "";

    sale.items.forEach((item) => {
      const medicineId = String(item.medicineId);
      if (!wanted.has(medicineId)) return;
      const batch = lotLabel(item.batchNumber, mfgDates.get(String(item.batchId)), item.expiryDate);
      // Sold before the drug was controlled: counts towards the balance, but it
      // was an ordinary sale, with no prescriber to record.
      const unlisted = !isControlledSchedule(item.schedule);
      if (createdAt >= from) {
        events.push({
          medicineId,
          at: createdAt,
          delta: -item.quantity,
          schedule: item.schedule,
          unlisted,
          batch,
          patient,
          prescribedBy,
          recipient: record?.recipientName || patient,
          dispenser: sale.soldByName ?? "",
          remarks: billNo,
        });
      }
      if (sale.voidedAt && new Date(sale.voidedAt as unknown as Date) >= from) {
        events.push({
          medicineId,
          at: new Date(sale.voidedAt as unknown as Date),
          delta: item.quantity,
          schedule: item.schedule,
          unlisted,
          batch,
          patient,
          remarks: `${billNo} cancelled`,
        });
      }
    });

    for (const entry of sale.returns ?? []) {
      const at = new Date(entry.returnedAt as unknown as Date);
      if (at < from) continue;
      for (const item of entry.items) {
        const medicineId = String(item.medicineId);
        if (!wanted.has(medicineId)) continue;
        const original = sale.items[item.lineIndex];
        events.push({
          medicineId,
          at,
          delta: item.quantity,
          schedule: original?.schedule,
          unlisted: !isControlledSchedule(original?.schedule),
          batch: item.batchNumber,
          patient,
          remarks: `Returned by patient, ${entry.creditNoteNo || billNo}`,
        });
      }
    }
  }

  for (const purchase of purchases) {
    const postedAt = new Date((purchase.postedAt ?? purchase.createdAt) as unknown as Date);
    if (postedAt >= from) {
      for (const item of purchase.items) {
        const medicineId = String(item.medicineId);
        if (!wanted.has(medicineId)) continue;
        events.push({
          medicineId,
          at: postedAt,
          delta: item.quantity + (item.freeQuantity ?? 0),
          batch: lotLabel(item.batchNumber, item.mfgDate, item.expiryDate),
          supplier: purchase.supplierName ?? "",
          remarks: purchase.grnNo,
        });
      }
    }
    for (const entry of purchase.returns ?? []) {
      const at = new Date(entry.returnedAt as unknown as Date);
      if (at < from) continue;
      for (const item of entry.items) {
        const medicineId = String(item.medicineId);
        if (!wanted.has(medicineId)) continue;
        events.push({
          medicineId,
          at,
          delta: -item.quantity,
          batch: item.batchNumber,
          supplier: purchase.supplierName ?? "",
          remarks: `Returned to supplier, ${entry.debitNoteNo || purchase.grnNo}`,
        });
      }
    }
  }

  for (const move of movements) {
    events.push({
      medicineId: String(move.medicineId),
      at: new Date(move.createdAt as unknown as Date),
      delta: move.direction === "in" ? move.quantity : -move.quantity,
      batch: move.batchNumber ?? "",
      dispenser: move.performedByName ?? "",
      remarks: [move.kind, move.reason || move.reasonCode].filter(Boolean).join(": "),
    });
  }

  const currentStock = new Map(stock.map((row) => [String(row._id), row.quantity]));
  const byId = new Map(medicines.map((medicine) => [String(medicine._id), medicine]));
  const lines = registerLines(events, currentStock, to).sort(
    (a, b) =>
      (byId.get(a.medicineId)?.name ?? soldNames.get(a.medicineId) ?? "").localeCompare(
        byId.get(b.medicineId)?.name ?? soldNames.get(b.medicineId) ?? "",
      ) ||
      a.at.getTime() - b.at.getTime(),
  );

  return {
    title: "Narcotic and Psychotropic Register",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Controlled medicines", value: String(medicines.length) },
      { label: "Entries", value: String(lines.length) },
    ],
    columns: [
      { key: "generic", header: "Generic name", type: "text", width: 18 },
      { key: "trade", header: "Trade name", type: "text", width: 18 },
      { key: "manufacturer", header: "Manufacturer", type: "text", width: 14 },
      { key: "schedule", header: "Class", type: "text", width: 11 },
      { key: "date", header: "Date (BS)", type: "text", width: 11 },
      { key: "batch", header: "Batch no, Mfg & Exp", type: "text", width: 22 },
      { key: "received", header: "Qty received", type: "integer" },
      { key: "supplier", header: "Supplier", type: "text", width: 16 },
      { key: "patient", header: "Patient", type: "text", width: 16 },
      { key: "dispensed", header: "Qty dispensed", type: "integer" },
      { key: "prescribedBy", header: "Prescribed by", type: "text", width: 20 },
      { key: "recipient", header: "Recipient name & sig.", type: "text", width: 18 },
      { key: "dispenser", header: "Dispenser name & sig.", type: "text", width: 18 },
      { key: "inStock", header: "Qty in stock", type: "integer" },
      { key: "remarks", header: "Remarks", type: "text", width: 22 },
    ],
    rows: lines.map((line): ReportRow => {
      const medicine = byId.get(line.medicineId);
      return {
        generic: medicine?.genericName ?? "",
        trade: medicine?.name ?? soldNames.get(line.medicineId) ?? "",
        manufacturer: medicine?.manufacturer ?? "",
        schedule: MEDICINE_SCHEDULE_LABELS[(line.schedule ?? medicine?.schedule) as MedicineSchedule] ?? "",
        date: bsDateOf(line.at),
        batch: line.batch,
        received: line.delta > 0 ? line.delta : null,
        supplier: line.supplier ?? "",
        patient: line.patient ?? "",
        dispensed: line.delta < 0 ? -line.delta : null,
        prescribedBy: line.prescribedBy ?? "",
        recipient: line.recipient ?? "",
        dispenser: line.dispenser ?? "",
        inStock: line.inStock,
        remarks: line.remarks ?? "",
      };
    }),
    note: "Follows DDA's Retailer's Record for Narcotics and Psychotropic Medicines. Sign the recipient and dispenser columns on the printed copy, and keep it with the prescriptions.",
  };
}
