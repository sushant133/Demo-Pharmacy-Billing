import { Types } from "mongoose";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { getExpiryAlerts, getStockAlerts } from "@/lib/alerts";
import { getMedicinePerformance, getProfitSummary } from "@/lib/analytics";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { pharmacyMatch } from "@/lib/tenant";
import { EXPIRY_LABEL, STOCK_LABEL } from "@/lib/alert-rules";
import {
  MOVEMENT_KIND_LABELS,
  type MovementDirection,
  type MovementKind,
} from "@/lib/movement-kinds";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import { REFUND_METHOD_LABELS, isRefundMethod } from "@/lib/return-eligibility";
import { Batch } from "@/models/Batch";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import { getBalancesFor } from "@/lib/suppliers";
import type { ReportDataset } from "@/lib/export/dataset";

/**
 * Report builders.
 *
 * Each returns a format-neutral ReportDataset, which the CSV, Excel and PDF
 * renderers then turn into bytes. Adding a report means adding one function
 * here and one entry in REPORTS - nothing in the exporters changes.
 */

export const REPORT_KEYS = [
  "sales-register",
  "sales-detail",
  "sales-returns",
  "stock-movements",
  "profit-by-medicine",
  "stock-valuation",
  "expiry",
  "reorder",
  "purchase-register",
  "payables",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export interface ReportRequest {
  from: Date;
  to: Date;
  /** Inclusive label for the range, e.g. "1 Aug 2026 - 31 Aug 2026". */
  rangeLabel: string;
  scope?: BranchScope;
  /**
   * Narrowing that only some reports understand.
   *
   * Carried on the request rather than encoded into more report keys: "stock
   * in" and "stock out" are the same report read in one direction, and minting
   * a key per combination would multiply the list every time a screen gained a
   * filter. Reports that do not read these ignore them.
   */
  direction?: MovementDirection | "both";
  kinds?: readonly MovementKind[];
}

export const REPORT_LABELS: Record<ReportKey, string> = {
  "sales-register": "Sales register",
  "sales-detail": "Sales detail (per item)",
  "sales-returns": "Returns register",
  "stock-movements": "Stock movements",
  "profit-by-medicine": "Profit by medicine",
  "stock-valuation": "Stock valuation",
  expiry: "Expiry report",
  reorder: "Reorder report",
  "purchase-register": "Purchase register",
  payables: "Supplier payables",
};

export const REPORT_DESCRIPTIONS: Record<ReportKey, string> = {
  "sales-register": "One row per bill, with VAT and payment mode.",
  "sales-detail": "One row per dispensed line, including batch and expiry.",
  "sales-returns": "One row per return, with reason, refund method and value.",
  "stock-movements": "Everything that moved stock, from every source.",
  "profit-by-medicine": "Revenue, cost and margin per medicine.",
  "stock-valuation": "Every lot on the shelf, valued at cost.",
  expiry: "Batches graded by urgency, with the money genuinely at risk.",
  reorder: "What to order, with a suggested quantity.",
  "purchase-register": "Deliveries received, with VAT and payment status.",
  payables: "What is owed to each supplier, and what is overdue.",
};

/** Which reports are scoped by the date range (the rest are point-in-time). */
export const DATED_REPORTS: ReadonlySet<ReportKey> = new Set([
  "sales-register",
  "sales-detail",
  "sales-returns",
  "stock-movements",
  "profit-by-medicine",
  "purchase-register",
]);

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

async function salesRegister({ from, to, rangeLabel, scope }: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const [sales, summary] = await Promise.all([
    Sale.find({ createdAt: { $gte: from, $lt: to }, voidedAt: null, ...branchFilter(scope) })
      .sort({ createdAt: 1 })
      .lean(),
    getProfitSummary(from, to, scope),
  ]);

  return {
    title: "Sales Register",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Bills", value: String(summary.billCount) },
      { label: "Revenue (excl. VAT)", value: summary.revenue.toFixed(2) },
      { label: "VAT collected", value: summary.vat.toFixed(2) },
      { label: "Gross profit", value: summary.grossProfit.toFixed(2) },
    ],
    columns: [
      { key: "billNo", header: "Bill no", type: "text", width: 16 },
      { key: "date", header: "Date", type: "date" },
      { key: "customer", header: "Customer", type: "text", width: 24 },
      { key: "units", header: "Units", type: "integer", total: true },
      { key: "subtotal", header: "Subtotal", type: "money", total: true },
      { key: "discount", header: "Discount", type: "money", total: true },
      { key: "taxable", header: "Taxable", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "total", header: "Total", type: "money", total: true },
      { key: "cost", header: "Cost", type: "money", total: true },
      { key: "profit", header: "Profit", type: "money", total: true },
      { key: "payment", header: "Paid by", type: "text" },
      { key: "cashier", header: "Cashier", type: "text", width: 18 },
    ],
    rows: sales.map((sale) => ({
      billNo: sale.billNo,
      date: new Date(sale.createdAt as unknown as Date),
      customer: sale.customerName || "Walk-in",
      units:
        sale.items.reduce((sum, item) => sum + item.quantity, 0) -
        (sale.returnedUnits ?? 0),
      subtotal: sale.subtotal,
      discount: sale.discount,
      taxable: round2(sale.taxableAmount - (sale.returnedTaxable ?? 0)),
      vat: round2(sale.vatAmount - (sale.returnedVat ?? 0)),
      total: round2(sale.totalAmount - (sale.returnedTotal ?? 0)),
      cost: round2((sale.totalCost ?? 0) - (sale.returnedCost ?? 0)),
      profit: round2(
        sale.taxableAmount -
          (sale.returnedTaxable ?? 0) -
          ((sale.totalCost ?? 0) - (sale.returnedCost ?? 0)),
      ),
      payment: PAYMENT_MODE_LABELS[sale.paymentMode as PaymentMode] ?? sale.paymentMode,
      cashier: sale.soldByName ?? "",
    })),
    note: "Revenue and profit exclude VAT, which is collected on behalf of the IRD. Voided bills are excluded.",
  };
}

async function salesDetail({ from, to, rangeLabel, scope }: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const sales = await Sale.find({
    createdAt: { $gte: from, $lt: to },
    voidedAt: null,
    ...branchFilter(scope),
  })
    .sort({ createdAt: 1 })
    .lean();

  const rows = sales.flatMap((sale) =>
    sale.items
      .filter((item) => item.quantity - (item.returnedQuantity ?? 0) > 0)
      .map((item) => ({
      billNo: sale.billNo,
      date: new Date(sale.createdAt as unknown as Date),
      medicine: item.medicineName,
      batch: item.batchNumber,
      expiry: item.expiryDate ? new Date(item.expiryDate) : null,
      quantity: item.quantity - (item.returnedQuantity ?? 0),
      unitPrice: item.unitPrice,
      unitCost: item.unitCost ?? 0,
      revenue: round2(
        item.quantity > 0
          ? (item.subtotal * (item.quantity - (item.returnedQuantity ?? 0))) /
            item.quantity
          : 0,
      ),
      cost: round2(
        item.quantity > 0
          ? ((item.lineCost ?? 0) *
              (item.quantity - (item.returnedQuantity ?? 0))) /
            item.quantity
          : 0,
      ),
      profit: round2(
        item.quantity > 0
          ? ((item.subtotal - (item.lineCost ?? 0)) *
              (item.quantity - (item.returnedQuantity ?? 0))) /
            item.quantity
          : 0,
      ),
    })),
  );

  return {
    title: "Sales Detail",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Lines", value: String(rows.length) }],
    columns: [
      { key: "billNo", header: "Bill no", type: "text", width: 16 },
      { key: "date", header: "Date", type: "date" },
      { key: "medicine", header: "Medicine", type: "text", width: 30 },
      { key: "batch", header: "Batch", type: "text", width: 14 },
      { key: "expiry", header: "Expiry", type: "date" },
      { key: "quantity", header: "Qty", type: "integer", total: true },
      { key: "unitPrice", header: "Rate", type: "money" },
      { key: "unitCost", header: "Unit cost", type: "money" },
      { key: "revenue", header: "Revenue", type: "money", total: true },
      { key: "cost", header: "Cost", type: "money", total: true },
      { key: "profit", header: "Profit", type: "money", total: true },
    ],
    rows,
    note: "Line revenue is before any bill-level discount. Unit cost is what the shop paid for that specific lot.",
  };
}

async function profitByMedicine({
  from,
  to,
  rangeLabel,
  scope,
}: ReportRequest): Promise<ReportDataset> {
  const [rows, summary] = await Promise.all([
    getMedicinePerformance(from, to, { limit: 2000, by: "profit", scope }),
    getProfitSummary(from, to, scope),
  ]);

  return {
    title: "Profit by Medicine",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Revenue (excl. VAT)", value: summary.revenue.toFixed(2) },
      { label: "Gross profit", value: summary.grossProfit.toFixed(2) },
      { label: "Overall margin", value: `${summary.marginPercent.toFixed(1)}%` },
    ],
    columns: [
      { key: "medicine", header: "Medicine", type: "text", width: 34 },
      { key: "units", header: "Units sold", type: "integer", total: true },
      { key: "bills", header: "Bills", type: "integer", total: true },
      { key: "revenue", header: "Revenue", type: "money", total: true },
      { key: "cost", header: "Cost", type: "money", total: true },
      { key: "profit", header: "Profit", type: "money", total: true },
      { key: "margin", header: "Margin", type: "percent" },
    ],
    rows: rows.map((row) => ({
      medicine: row.medicineName,
      units: row.unitsSold,
      bills: row.billCount,
      revenue: row.revenue,
      cost: row.cost,
      profit: row.profit,
      margin: row.marginPercent,
    })),
    note: "Bill-level discounts are allocated to each line in proportion to its share of the bill.",
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function stockValuation({ scope }: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const batches = await Batch.find({ quantity: { $gt: 0 }, ...branchFilter(scope) })
    .sort({ expiryDate: 1 })
    .populate<{ medicineId: { _id: Types.ObjectId; name: string; unit?: string } }>(
      "medicineId",
      "name unit",
    )
    .lean();

  const now = Date.now();

  const rows = batches.map((batch) => {
    const medicine = batch.medicineId as unknown as { name?: string; unit?: string } | null;
    const expiry = new Date(batch.expiryDate);
    return {
      medicine: medicine?.name ?? "Unknown medicine",
      unit: medicine?.unit ?? "unit",
      batch: batch.batchNumber,
      expiry,
      status: expiry.getTime() < now ? "Expired" : "In date",
      quantity: batch.quantity,
      costPrice: batch.costPrice,
      salePrice: batch.salePrice,
      costValue: round2(batch.quantity * batch.costPrice),
      retailValue: round2(batch.quantity * batch.salePrice),
      grn: batch.grnNo ?? "",
    };
  });

  return {
    title: "Stock Valuation",
    subtitle: `As at ${new Date().toLocaleDateString("en-GB")}`,
    generatedAt: new Date(),
    meta: [{ label: "Lots in stock", value: String(rows.length) }],
    columns: [
      { key: "medicine", header: "Medicine", type: "text", width: 30 },
      { key: "batch", header: "Batch", type: "text", width: 14 },
      { key: "expiry", header: "Expiry", type: "date" },
      { key: "status", header: "Status", type: "text" },
      { key: "quantity", header: "Qty", type: "integer", total: true },
      { key: "costPrice", header: "Cost", type: "money" },
      { key: "salePrice", header: "MRP", type: "money" },
      { key: "costValue", header: "Cost value", type: "money", total: true },
      { key: "retailValue", header: "Retail value", type: "money", total: true },
      { key: "grn", header: "GRN", type: "text", width: 14 },
    ],
    rows,
    note: "Cost value is what the stock is worth to the business; retail value is what it would fetch at current MRP.",
  };
}

async function expiryReport({ scope }: ReportRequest): Promise<ReportDataset> {
  const { rows, totalValueAtRisk } = await getExpiryAlerts({
    withinDays: config.expiryAlertDays,
    includeExpired: true,
    pageSize: 5000,
    scope,
  });

  return {
    title: "Expiry Report",
    subtitle: `Batches expiring within ${config.expiryAlertDays} days, plus anything already expired`,
    generatedAt: new Date(),
    meta: [
      { label: "Lots flagged", value: String(rows.length) },
      { label: "Value at risk", value: totalValueAtRisk.toFixed(2) },
    ],
    columns: [
      { key: "medicine", header: "Medicine", type: "text", width: 30 },
      { key: "batch", header: "Batch", type: "text", width: 14 },
      { key: "expiry", header: "Expiry", type: "date" },
      { key: "days", header: "Days left", type: "integer" },
      { key: "severity", header: "Status", type: "text", width: 18 },
      { key: "quantity", header: "Qty", type: "integer", total: true },
      { key: "salesRate", header: "Sales/day", type: "number" },
      { key: "stockValue", header: "Stock value", type: "money", total: true },
      { key: "atRisk", header: "At risk", type: "money", total: true },
      { key: "grn", header: "GRN", type: "text", width: 14 },
    ],
    rows: rows.map((row) => ({
      medicine: row.medicineName,
      batch: row.batchNumber,
      expiry: new Date(row.expiryDate),
      days: row.daysRemaining,
      severity: EXPIRY_LABEL[row.severity],
      quantity: row.quantity,
      salesRate: row.salesRate,
      stockValue: row.stockValue,
      atRisk: row.valueAtRisk,
      grn: row.grnNo,
    })),
    note: "'At risk' is the portion that cannot sell before expiry at the current rate - not the whole lot.",
  };
}

async function reorderReport({ scope }: ReportRequest): Promise<ReportDataset> {
  const { rows } = await getStockAlerts({ pageSize: 5000, scope });

  // Only what actually needs ordering; healthy stock is noise on this report.
  const actionable = rows.filter(
    (row) => row.assessment.suggestedOrderQuantity > 0,
  );

  return {
    title: "Reorder Report",
    subtitle: "What to order, based on the last 90 days of sales",
    generatedAt: new Date(),
    meta: [{ label: "Items to order", value: String(actionable.length) }],
    columns: [
      { key: "medicine", header: "Medicine", type: "text", width: 30 },
      { key: "category", header: "Category", type: "text" },
      { key: "stock", header: "In stock", type: "integer", total: true },
      { key: "salesRate", header: "Sales/day", type: "number" },
      { key: "cover", header: "Days cover", type: "number" },
      { key: "status", header: "Status", type: "text", width: 22 },
      { key: "suggested", header: "Order qty", type: "integer", total: true },
      { key: "basis", header: "Based on", type: "text", width: 16 },
    ],
    rows: actionable.map((row) => ({
      medicine: row.medicineName,
      category: row.category,
      stock: row.stockQuantity,
      salesRate: row.salesRate,
      cover: row.assessment.daysOfCover,
      status: STOCK_LABEL[row.assessment.severity],
      suggested: row.assessment.suggestedOrderQuantity,
      basis:
        row.assessment.basis === "days-of-cover" ? "Sales rate" : "Reorder level",
    })),
    note: "Suggested quantity targets 45 days of cover plus a 7-day lead time. Items with no sales history fall back to their reorder level.",
  };
}

// ---------------------------------------------------------------------------
// Purchasing
// ---------------------------------------------------------------------------

async function purchaseRegister({
  from,
  to,
  rangeLabel,
  scope,
}: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const purchases = await Purchase.find({
    status: "posted",
    receivedDate: { $gte: from, $lt: to },
    ...branchFilter(scope),
  })
    .sort({ receivedDate: 1 })
    .lean();

  return {
    title: "Purchase Register",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [{ label: "Deliveries", value: String(purchases.length) }],
    columns: [
      { key: "grnNo", header: "GRN no", type: "text", width: 16 },
      { key: "date", header: "Received", type: "date" },
      { key: "supplier", header: "Supplier", type: "text", width: 28 },
      { key: "invoice", header: "Their invoice", type: "text", width: 18 },
      { key: "units", header: "Units", type: "integer", total: true },
      { key: "subtotal", header: "Subtotal", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "total", header: "Total", type: "money", total: true },
      { key: "paid", header: "Paid", type: "money", total: true },
      { key: "due", header: "Outstanding", type: "money", total: true },
      { key: "dueDate", header: "Due", type: "date" },
    ],
    rows: purchases.map((purchase) => ({
      grnNo: purchase.grnNo,
      date: new Date(purchase.receivedDate),
      supplier: purchase.supplierName,
      invoice: purchase.invoiceNo ?? "",
      units: purchase.items.reduce(
        (sum, item) => sum + item.quantity + item.freeQuantity,
        0,
      ),
      subtotal: purchase.subtotal,
      vat: purchase.vatAmount,
      total: purchase.totalAmount,
      paid: purchase.amountPaid,
      due: round2(purchase.totalAmount - purchase.amountPaid),
      dueDate: purchase.dueDate ? new Date(purchase.dueDate) : null,
    })),
    note: "Only posted purchases are listed; drafts have not created stock and are not liabilities.",
  };
}

async function payablesReport(request: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const tenant = pharmacyMatch(request.scope);
  const suppliers = await Supplier.find(tenant).sort({ name: 1 }).lean();
  const balances = await getBalancesFor(
    suppliers.map((supplier) => supplier._id),
    request.scope?.pharmacyId ?? null,
  );

  const now = new Date();
  const overdueRows = await Purchase.aggregate([
    {
      $match: {
        ...tenant,
        status: "posted",
        paymentStatus: { $ne: "paid" },
        dueDate: { $lt: now },
      },
    },
    {
      $group: {
        _id: "$supplierId",
        overdue: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
      },
    },
  ]);
  const overdueById = new Map(
    (overdueRows as Array<{ _id: Types.ObjectId; overdue: number }>).map((row) => [
      String(row._id),
      row.overdue,
    ]),
  );

  const lastPaymentRows = await SupplierPayment.aggregate([
    { $group: { _id: "$supplierId", lastPaidOn: { $max: "$paidOn" } } },
  ]);
  const lastPaidById = new Map(
    (lastPaymentRows as Array<{ _id: Types.ObjectId; lastPaidOn: Date }>).map((row) => [
      String(row._id),
      new Date(row.lastPaidOn),
    ]),
  );

  const rows = suppliers
    .map((supplier) => {
      const id = String(supplier._id);
      const balance = balances.get(id) ?? { purchased: 0, paid: 0 };
      const outstanding = round2(
        (supplier.openingBalance ?? 0) + balance.purchased - balance.paid,
      );
      return {
        supplier: supplier.name,
        contact: supplier.contactPerson ?? "",
        phone: supplier.phone ?? "",
        terms: supplier.paymentTermsDays ?? 0,
        purchased: balance.purchased,
        paid: balance.paid,
        outstanding,
        overdue: round2(overdueById.get(id) ?? 0),
        lastPaid: lastPaidById.get(id) ?? null,
      };
    })
    // A supplier settled in full is not a payable; keep the report actionable.
    .filter((row) => row.outstanding !== 0 || row.purchased > 0);

  return {
    title: "Supplier Payables",
    subtitle: `As at ${now.toLocaleDateString("en-GB")}`,
    generatedAt: now,
    meta: [{ label: "Suppliers listed", value: String(rows.length) }],
    columns: [
      { key: "supplier", header: "Supplier", type: "text", width: 28 },
      { key: "contact", header: "Contact", type: "text", width: 20 },
      { key: "phone", header: "Phone", type: "text", width: 14 },
      { key: "terms", header: "Terms (d)", type: "integer" },
      { key: "purchased", header: "Purchased", type: "money", total: true },
      { key: "paid", header: "Paid", type: "money", total: true },
      { key: "outstanding", header: "Outstanding", type: "money", total: true },
      { key: "overdue", header: "Overdue", type: "money", total: true },
      { key: "lastPaid", header: "Last paid", type: "date" },
    ],
    rows,
    note: "Balances are derived from posted purchases and recorded payments, including any opening balance.",
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Returns register: one row per return event, not per bill.
 *
 * Two returns on the same invoice are two things that happened - different
 * days, different reasons, possibly different cashiers - and rolling them into
 * one row would hide the second. The screen's history table is built the same
 * way, so the export and what it was exported from agree.
 *
 * Voided bills are excluded: voiding already put every unit back, so counting
 * its returns as well would double the stock that came off the shelf.
 */
async function salesReturns({
  from,
  to,
  rangeLabel,
  scope,
}: ReportRequest): Promise<ReportDataset> {
  await connectDB();

  const rows = await Sale.aggregate<{
    billNo: string;
    customerName: string;
    customerPhone: string;
    returnedAt: Date;
    returnedByName: string;
    reason: string;
    refundMethod: string;
    conditionConfirmed: boolean;
    units: number;
    taxableAmount: number;
    vatAmount: number;
    totalAmount: number;
    refundPaid?: number;
    totalCost: number;
  }>([
    { $match: { ...branchFilter(scope), voidedAt: null, "returns.0": { $exists: true } } },
    { $unwind: "$returns" },
    { $match: { "returns.returnedAt": { $gte: from, $lt: to } } },
    { $sort: { "returns.returnedAt": 1 } },
    {
      $project: {
        _id: 0,
        billNo: 1,
        customerName: 1,
        customerPhone: 1,
        returnedAt: "$returns.returnedAt",
        returnedByName: "$returns.returnedByName",
        reason: "$returns.reason",
        refundMethod: "$returns.refundMethod",
        conditionConfirmed: "$returns.conditionConfirmed",
        units: "$returns.units",
        taxableAmount: "$returns.taxableAmount",
        vatAmount: "$returns.vatAmount",
        totalAmount: "$returns.totalAmount",
        refundPaid: "$returns.refundPaid",
        totalCost: "$returns.totalCost",
      },
    },
  ]);

  const refunded = round2(rows.reduce((sum, row) => sum + (row.totalAmount ?? 0), 0));
  const units = rows.reduce((sum, row) => sum + (row.units ?? 0), 0);

  return {
    title: "Returns Register",
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Returns", value: String(rows.length) },
      { label: "Units back on the shelf", value: String(units) },
      { label: "Refunded", value: refunded.toFixed(2) },
    ],
    columns: [
      { key: "date", header: "Returned", type: "date" },
      { key: "billNo", header: "Bill no", type: "text", width: 16 },
      { key: "customer", header: "Customer", type: "text", width: 22 },
      { key: "phone", header: "Phone", type: "text", width: 14 },
      { key: "reason", header: "Reason", type: "text", width: 30 },
      { key: "refund", header: "Refunded as", type: "text", width: 18 },
      { key: "units", header: "Units", type: "integer", total: true },
      { key: "taxable", header: "Taxable", type: "money", total: true },
      { key: "vat", header: "VAT", type: "money", total: true },
      { key: "total", header: "Refund", type: "money", total: true },
      { key: "paidOut", header: "Handed back", type: "money", total: true },
      { key: "cost", header: "Cost returned", type: "money", total: true },
      { key: "checked", header: "Condition checked", type: "text" },
      { key: "by", header: "By", type: "text", width: 18 },
    ],
    rows: rows.map((row) => ({
      date: new Date(row.returnedAt),
      billNo: row.billNo,
      customer: row.customerName || "Walk-in",
      phone: row.customerPhone || "",
      reason: row.reason || "",
      // Blank on returns taken before the method was recorded. Said plainly
      // rather than defaulted to cash: a till reconciliation that assumes
      // money left the drawer is worse than one admitting it cannot tell.
      refund: isRefundMethod(row.refundMethod)
        ? REFUND_METHOD_LABELS[row.refundMethod]
        : "Not recorded",
      units: row.units ?? 0,
      taxable: round2(row.taxableAmount ?? 0),
      vat: round2(row.vatAmount ?? 0),
      total: round2(row.totalAmount ?? 0),
      // What left the drawer or went back to the card. Older returns carry no
      // split: anything but "reduce what they owe" was handed back in full.
      paidOut: round2(
        row.refundPaid ?? (row.refundMethod === "adjust" ? 0 : row.totalAmount ?? 0),
      ),
      cost: round2(row.totalCost ?? 0),
      checked: row.conditionConfirmed ? "Yes" : "No",
      by: row.returnedByName || "",
    })),
  };
}

/**
 * Stock movements: the ledger, exported.
 *
 * Reads through `readLedger` rather than re-querying, so the file and the
 * screen are the same list by construction. A stock-in export and a stock-out
 * export are this report with a different `direction`, which is why that lives
 * on the request instead of being two more report keys.
 */
async function stockMovements({
  from,
  to,
  rangeLabel,
  scope,
  direction,
  kinds,
}: ReportRequest): Promise<ReportDataset> {
  const { readLedger } = await import("@/lib/stock-ledger");

  const page = await readLedger({
    scope,
    start: from,
    end: to,
    direction: direction ?? "both",
    kinds,
  });

  const title =
    direction === "in"
      ? "Stock In"
      : direction === "out"
        ? "Stock Out"
        : "Stock Movements";

  return {
    title,
    subtitle: rangeLabel,
    generatedAt: new Date(),
    meta: [
      { label: "Movements", value: String(page.entries.length) },
      { label: "Units", value: String(page.totalUnits) },
      { label: "Value at cost", value: page.totalValue.toFixed(2) },
    ],
    columns: [
      { key: "date", header: "When", type: "date" },
      { key: "kind", header: "Movement", type: "text", width: 20 },
      { key: "medicine", header: "Medicine", type: "text", width: 28 },
      { key: "lot", header: "Lot", type: "text", width: 14 },
      { key: "expiry", header: "Expiry", type: "date" },
      { key: "supplier", header: "Supplier", type: "text", width: 22 },
      { key: "units", header: "Units", type: "integer", total: true },
      { key: "unitCost", header: "Unit cost", type: "money" },
      { key: "value", header: "Value", type: "money", total: true },
      { key: "reference", header: "Reference", type: "text", width: 18 },
      { key: "branch", header: "Branch", type: "text", width: 16 },
      { key: "reason", header: "Reason", type: "text", width: 26 },
      { key: "by", header: "By", type: "text", width: 18 },
    ],
    rows: page.entries.map((entry) => ({
      date: entry.at,
      kind: MOVEMENT_KIND_LABELS[entry.kind] ?? entry.kind,
      medicine: entry.medicineName,
      lot: entry.batchNumber,
      expiry: entry.expiryDate,
      supplier: entry.supplier,
      units: entry.quantity,
      unitCost: entry.unitCost,
      value: entry.value,
      reference: entry.reference,
      branch: entry.branchName,
      reason: entry.reason,
      by: entry.by,
    })),
    note: "Deliveries and dispensing are read from the GRN and the bill; adjustments, write-offs and transfers from the movement ledger.",
  };
}

const BUILDERS: Record<ReportKey, (request: ReportRequest) => Promise<ReportDataset>> = {
  "sales-register": salesRegister,
  "sales-detail": salesDetail,
  "sales-returns": salesReturns,
  "stock-movements": stockMovements,
  "profit-by-medicine": profitByMedicine,
  "stock-valuation": stockValuation,
  expiry: expiryReport,
  reorder: reorderReport,
  "purchase-register": purchaseRegister,
  payables: payablesReport,
};

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

export function buildReport(
  key: ReportKey,
  request: ReportRequest,
): Promise<ReportDataset> {
  return BUILDERS[key](request);
}
