import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { getSettings } from "@/lib/settings";
import { connectDB } from "@/lib/db";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import {
  allocateFefo,
  calculateTotals,
  describeShortfall,
  FefoError,
  planStockReturn,
  round2,
  type AllocatableBatch,
  type AllocatedLine,
  type StockReturn,
} from "@/lib/fefo";
import { branchForWrite } from "@/lib/branches";
import { planSaleReturn } from "@/lib/sale-return";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Sale } from "@/models/Sale";
import { formatBillNo, nextSequence } from "@/models/Counter";
import { Customer } from "@/models/Customer";
import { adToBs, nepaliFiscalYear } from "@/lib/bs-date";
import { localParts } from "@/lib/dates";
import type { CreateSaleInput, ReturnSaleInput } from "@/lib/validation";
import type { SessionUser } from "@/lib/session";

/**
 * Sale creation: the one place stock leaves the building.
 *
 * The flow is deliberately split in two:
 *   1. `planSale` - pure read + pure FEFO allocation. Produces a plan the POS
 *      can preview ("which batches will be used?") without writing anything.
 *   2. `createSale` - re-plans inside the transaction and commits the plan.
 *
 * Re-planning at commit time matters: the preview the cashier saw may be
 * seconds old, and another till may have sold the same batch in between.
 */

export interface SalePlanPick {
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitPrice: number;
  /** Cost per unit of this lot, captured now for COGS. */
  unitCost: number;
  expiryDate: string;
  subtotal: number;
  lineCost: number;
}

export interface SalePlanLine {
  medicineId: string;
  medicineName: string;
  unit: string;
  requestedQuantity: number;
  lineTotal: number;
  lineCost: number;
  picks: SalePlanPick[];
  /** True when FEFO had to draw from more than one batch. */
  split: boolean;
}

export interface SalePlan {
  lines: SalePlanLine[];
  subtotal: number;
  discount: number;
  /** 0 when the discount was entered as a rupee amount. */
  discountPercent: number;
  taxableAmount: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
  /** Cost of goods on this bill. */
  totalCost: number;
  /** taxableAmount - totalCost. Excludes VAT, which is never the shop's. */
  grossProfit: number;
}

interface PlanInternals {
  plan: SalePlan;
  allocation: AllocatedLine[];
  medicineNames: Map<string, string>;
}

/**
 * Load candidate batches and run FEFO. Throws ApiError on any shortfall, with
 * a message naming the medicine so the cashier can act on it.
 */
async function buildPlan(
  input: Pick<CreateSaleInput, "items" | "discount" | "discountPercent">,
  asOf: Date,
  branchId: Types.ObjectId,
  pharmacyId: Types.ObjectId,
): Promise<PlanInternals> {
  const medicineIds = [...new Set(input.items.map((item) => item.medicineId))];

  const medicines = await Medicine.find({
    pharmacyId,
    _id: { $in: medicineIds.map((id) => new Types.ObjectId(id)) },
  })
    .select("_id name unit isActive")
    .lean();

  const medicineNames = new Map<string, string>();
  const medicineUnits = new Map<string, string>();
  for (const medicine of medicines) {
    medicineNames.set(String(medicine._id), medicine.name);
    medicineUnits.set(String(medicine._id), medicine.unit ?? "unit");
  }

  const missing = medicineIds.filter((id) => !medicineNames.has(id));
  if (missing.length > 0) {
    throw ApiError.notFound(
      `${missing.length} item(s) on this bill no longer exist in the catalogue.`,
    );
  }

  const inactive = medicines.filter((m) => m.isActive === false);
  if (inactive.length > 0) {
    throw ApiError.badRequest(
      `${inactive.map((m) => m.name).join(", ")} is discontinued and cannot be sold.`,
    );
  }

  // Only lots with stock are worth loading; expired ones are still fetched so
  // FEFO can explain "you have stock, but all of it has expired".
  const batches = await Batch.find({
    pharmacyId,
    branchId,
    medicineId: { $in: medicineIds.map((id) => new Types.ObjectId(id)) },
    quantity: { $gt: 0 },
  })
    .select("_id medicineId batchNumber quantity salePrice costPrice expiryDate createdAt")
    .lean();

  const allocatable: AllocatableBatch[] = batches.map((batch) => ({
    batchId: String(batch._id),
    medicineId: String(batch.medicineId),
    batchNumber: batch.batchNumber,
    quantity: batch.quantity,
    salePrice: batch.salePrice,
    costPrice: batch.costPrice,
    expiryDate: new Date(batch.expiryDate),
    createdAt: batch.createdAt ? new Date(batch.createdAt) : undefined,
  }));

  const result = allocateFefo(input.items, allocatable, asOf);

  if (!result.ok) {
    const messages = result.shortfalls.map((shortfall) =>
      describeShortfall(shortfall, medicineNames.get(shortfall.medicineId)),
    );
    throw ApiError.insufficientStock(messages.join(" "), {
      shortfalls: result.shortfalls.map((shortfall) => ({
        ...shortfall,
        medicineName: medicineNames.get(shortfall.medicineId) ?? "",
      })),
    });
  }

  const grossSubtotal = result.lines.reduce((sum, line) => sum + line.lineTotal, 0);
  // The VAT rate comes from Settings, so a shop that is not VAT registered, or
  // that is charged at another rate, bills correctly without a redeploy. Past
  // bills are untouched: each sale stores the rate it was charged at.
  const { vatRate } = await getSettings(pharmacyId);
  const totals = calculateTotals({
    grossSubtotal,
    discount: input.discount ?? 0,
    discountPercent: input.discountPercent ?? 0,
    vatRate,
  });

  const lines: SalePlanLine[] = result.lines.map((line) => ({
    medicineId: line.medicineId,
    medicineName: medicineNames.get(line.medicineId) ?? "Unknown",
    unit: medicineUnits.get(line.medicineId) ?? "unit",
    requestedQuantity: line.requestedQuantity,
    lineTotal: line.lineTotal,
    lineCost: line.lineCost,
    split: line.picks.length > 1,
    picks: line.picks.map((pick) => ({
      batchId: pick.batchId,
      batchNumber: pick.batchNumber,
      quantity: pick.quantity,
      unitPrice: pick.unitPrice,
      unitCost: pick.unitCost,
      expiryDate: pick.expiryDate.toISOString(),
      subtotal: pick.subtotal,
      lineCost: pick.lineCost,
    })),
  }));

  const totalCost = round2(lines.reduce((sum, line) => sum + line.lineCost, 0));

  return {
    plan: {
      lines,
      vatRate,
      ...totals,
      totalCost,
      // VAT is collected for the government, so profit is measured against the
      // taxable amount rather than the total the customer handed over.
      grossProfit: round2(totals.taxableAmount - totalCost),
    },
    allocation: result.lines,
    medicineNames,
  };
}

/** Preview a sale without writing anything. Used by the POS cart. */
export async function planSale(
  input: Pick<CreateSaleInput, "items" | "discount" | "discountPercent">,
  user: SessionUser,
): Promise<SalePlan> {
  await connectDB();
  const branch = await branchForWrite(user);
  const { plan } = await buildPlan(
    input,
    new Date(),
    branch.id,
    pharmacyObjectId(user),
  );
  return plan;
}

export interface CreatedSale {
  id: string;
  billNo: string;
  totalAmount: number;
  plan: SalePlan;
}

/**
 * Commit a sale: deduct stock, then write the Sale document.
 *
 * Stock is deducted with a guarded update - `$inc: { quantity: -n }` filtered
 * on `quantity: { $gte: n }` - so the write itself fails if another till got
 * there first. That guard is what makes the standalone-MongoDB fallback safe:
 * even without a transaction, no batch can be driven negative, and any deduct
 * that did land is compensated on failure.
 */
export async function createSale(
  input: CreateSaleInput,
  user: SessionUser,
): Promise<CreatedSale> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const branch = await branchForWrite(user);
    const pharmacyId = pharmacyObjectId(user);
    // Re-plan inside the transaction: the cart preview may be stale.
    const { plan, allocation } = await buildPlan(
      input,
      new Date(),
      branch.id,
      pharmacyId,
    );

    for (const line of allocation) {
      for (const pick of line.picks) {
        const updated = await Batch.findOneAndUpdate(
          { _id: pick.batchId, pharmacyId, quantity: { $gte: pick.quantity } },
          { $inc: { quantity: -pick.quantity } },
          { new: true, ...sessionOption(session) },
        );

        if (!updated) {
          // Lost a race with a concurrent sale between planning and writing.
          throw ApiError.insufficientStock(
            `Batch ${pick.batchNumber} was sold out by another till while this bill was open. Please re-add the item and try again.`,
          );
        }

        // Only used on standalone MongoDB; a real transaction aborts instead.
        onRollback(() =>
          Batch.updateOne(
            { _id: pick.batchId, pharmacyId },
            { $inc: { quantity: pick.quantity } },
          ).exec(),
        );
      }
    }

    const issuedAt = new Date();
    const local = localParts(issuedAt);
    const bs = adToBs(local.year, local.month, local.day);
    const fiscalYear = nepaliFiscalYear(bs);
    const seq = await nextSequence(`${String(pharmacyId)}:sale:${fiscalYear}`, session);
    const billNo = formatBillNo(seq, fiscalYear);

    let customerPan = input.customerPan ?? "";
    let customerAddress = input.customerAddress ?? "";
    let customerPhone = input.customerPhone ?? "";
    if (input.customerId) {
      const saved = await Customer.findOne({
        _id: input.customerId,
        pharmacyId,
      })
        .select("panNo address phone name")
        .session(session)
        .lean();
      if (saved) {
        if (!customerPan) customerPan = saved.panNo ?? "";
        if (!customerAddress) customerAddress = saved.address ?? "";
        if (!customerPhone) customerPhone = saved.phone ?? "";
      }
    }

    const items = plan.lines.flatMap((line) =>
      line.picks.map((pick) => ({
        medicineId: new Types.ObjectId(line.medicineId),
        batchId: new Types.ObjectId(pick.batchId),
        medicineName: line.medicineName,
        batchNumber: pick.batchNumber,
        expiryDate: new Date(pick.expiryDate),
        quantity: pick.quantity,
        unit: line.unit,
        unitPrice: pick.unitPrice,
        unitCost: pick.unitCost,
        subtotal: pick.subtotal,
        lineCost: pick.lineCost,
      })),
    );

    const [sale] = await Sale.create(
      [
        {
          pharmacyId,
          billNo,
          billSeq: seq,
          fiscalYear,
          customerId: input.customerId ? new Types.ObjectId(input.customerId) : null,
          customerName: input.customerName ?? "",
          customerPan,
          customerAddress,
          customerPhone,
          items,
          subtotal: plan.subtotal,
          totalCost: plan.totalCost,
          discount: plan.discount,
          discountPercent: plan.discountPercent,
          taxableAmount: plan.taxableAmount,
          vatRate: plan.vatRate,
          vatAmount: plan.vatAmount,
          totalAmount: plan.totalAmount,
          paymentMode: input.paymentMode,
          soldBy: new Types.ObjectId(user.id),
          soldByName: user.name,
          branchId: branch.id,
          branchName: branch.name,
          note: input.note ?? "",
        },
      ],
      sessionOption(session),
    );

    if (!sale) throw new Error("Sale document was not created.");

    onRollback(() => Sale.deleteOne({ _id: sale._id }).exec());

    return {
      id: String(sale._id),
      billNo,
      totalAmount: round2(plan.totalAmount),
      plan,
    };
  });
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

export type { StockReturn };

export interface VoidedSale {
  id: string;
  billNo: string;
  voidedAt: Date;
  /** What went back on the shelf, per lot. */
  restored: StockReturn[];
  /** Lot numbers whose batch no longer exists, so nothing could be returned. */
  unreturned: StockReturn[];
}

/**
 * Void a bill and put its stock back.
 *
 * The bill is never deleted. It keeps its number and its lines, gains a reason
 * and an author, and drops out of every financial query - which is what makes
 * the void auditable rather than a hole in the record.
 *
 * Order matters: the void is *claimed* with a guarded update before any stock
 * moves. On a standalone MongoDB there is no transaction to serialise two
 * clerks pressing the button at once, so whoever matches `voidedAt: null`
 * first wins and the loser is refused - rather than both restoring the same
 * units and inflating the lot.
 */
export async function voidSale(
  id: string,
  reason: string,
  user: SessionUser,
): Promise<VoidedSale> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const voidedAt = new Date();

    const existing = await Sale.findOne({
      _id: id,
      ...pharmacyFilter(user),
    })
      .select("billNo voidedAt returnedUnits")
      .lean();
    if (!existing) throw ApiError.notFound("That bill no longer exists.");
    if (existing.voidedAt) {
      throw ApiError.conflict(`${existing.billNo} has already been voided.`);
    }
    if ((existing.returnedUnits ?? 0) > 0) {
      throw ApiError.conflict(
        `${existing.billNo} already has customer returns. Record further returns instead of voiding.`,
      );
    }

    const sale = await Sale.findOneAndUpdate(
      {
        _id: id,
        voidedAt: null,
        ...pharmacyFilter(user),
        $nor: [{ returnedUnits: { $gt: 0 } }],
      },
      {
        $set: {
          voidedAt,
          voidedBy: new Types.ObjectId(user.id),
          voidedByName: user.name,
          voidReason: reason,
        },
      },
      { new: true, ...sessionOption(session) },
    );

    if (!sale) {
      // Either the bill is gone or someone got there first; say which.
      const existing = await Sale.findOne({ _id: id, ...pharmacyFilter(user) })
        .select("billNo voidedAt")
        .lean();
      if (!existing) throw ApiError.notFound("That bill no longer exists.");
      throw ApiError.conflict(`${existing.billNo} has already been voided.`);
    }

    onRollback(() =>
      Sale.updateOne(
        { _id: sale._id },
        {
          $set: { voidedAt: null, voidedBy: null, voidedByName: "", voidReason: "" },
        },
      ).exec(),
    );

    const returns = planStockReturn(
      sale.items.map((item) => ({
        batchId: String(item.batchId),
        batchNumber: item.batchNumber,
        quantity: item.quantity,
      })),
    );

    const restored: StockReturn[] = [];
    const unreturned: StockReturn[] = [];

    for (const entry of returns) {
      const updated = await Batch.findOneAndUpdate(
        { _id: entry.batchId, ...pharmacyFilter(user) },
        { $inc: { quantity: entry.quantity } },
        { new: true, ...sessionOption(session) },
      );

      if (!updated) {
        // A lot on a bill should be undeletable, so this means the batch was
        // removed outside the app. Refusing the whole void would strand the
        // bill in the accounts forever, so record the shortfall and let the
        // caller tell the user which lot needs a manual correction.
        unreturned.push(entry);
        continue;
      }

      restored.push(entry);
      onRollback(() =>
        Batch.updateOne(
          { _id: entry.batchId, ...pharmacyFilter(user) },
          { $inc: { quantity: -entry.quantity } },
        ).exec(),
      );
    }

    return {
      id: String(sale._id),
      billNo: sale.billNo,
      voidedAt,
      restored,
      unreturned,
    };
  });
}

// ---------------------------------------------------------------------------
// Customer returns
// ---------------------------------------------------------------------------

export interface RecordedReturn {
  id: string;
  billNo: string;
  units: number;
  totalAmount: number;
  restored: StockReturn[];
  unreturned: StockReturn[];
}

/**
 * Put selected units from a live bill back on the lots they came from.
 *
 * The bill stays: it was a real sale. The return is a dated correction on it,
 * stock is incremented, and running totals are what reports subtract.
 */
export async function returnSaleItems(
  id: string,
  input: ReturnSaleInput,
  user: SessionUser,
): Promise<RecordedReturn> {
  await connectDB();

  return withTransaction(async ({ session, onRollback }) => {
    const sale = await Sale.findOne({
      _id: id,
      voidedAt: null,
      ...pharmacyFilter(user),
    }).session(session);

    if (!sale) {
      const existing = await Sale.findOne({ _id: id, ...pharmacyFilter(user) })
        .select("billNo voidedAt")
        .lean();
      if (!existing) throw ApiError.notFound("That bill no longer exists.");
      throw ApiError.conflict(`${existing.billNo} has been voided and cannot take a return.`);
    }

    let plan;
    try {
      plan = planSaleReturn(
        {
          items: sale.items.map((item) => ({
            quantity: item.quantity,
            returnedQuantity: item.returnedQuantity ?? 0,
            unitPrice: item.unitPrice,
            subtotal: item.subtotal,
            unitCost: item.unitCost ?? 0,
            lineCost: item.lineCost ?? 0,
            medicineId: String(item.medicineId),
            medicineName: item.medicineName,
            batchId: String(item.batchId),
            batchNumber: item.batchNumber,
          })),
          subtotal: sale.subtotal,
          discount: sale.discount,
          vatRate: sale.vatRate,
        },
        input.items,
      );
    } catch (error) {
      if (error instanceof FefoError) throw ApiError.badRequest(error.message);
      throw error;
    }

    const returnedAt = new Date();
    const pharmacyId = pharmacyObjectId(user);

    const restored: StockReturn[] = [];
    const unreturned: StockReturn[] = [];
    const stockMoves = planStockReturn(
      plan.items.map((item) => ({
        batchId: item.batchId,
        batchNumber: item.batchNumber,
        quantity: item.quantity,
      })),
    );

    for (const entry of stockMoves) {
      const updated = await Batch.findOneAndUpdate(
        { _id: entry.batchId, pharmacyId },
        { $inc: { quantity: entry.quantity } },
        { new: true, ...sessionOption(session) },
      );

      if (!updated) {
        unreturned.push(entry);
        continue;
      }

      restored.push(entry);
      onRollback(() =>
        Batch.updateOne(
          { _id: entry.batchId, pharmacyId },
          { $inc: { quantity: -entry.quantity } },
        ).exec(),
      );
    }

    for (const item of plan.items) {
      const line = sale.items[item.lineIndex];
      if (!line) continue;
      line.returnedQuantity = (line.returnedQuantity ?? 0) + item.quantity;
    }

    if (!sale.returns) sale.set("returns", []);
    sale.returns.push({
      returnedAt,
      returnedBy: new Types.ObjectId(user.id),
      returnedByName: user.name,
      reason: input.reason,
      items: plan.items.map((item) => ({
        lineIndex: item.lineIndex,
        medicineId: new Types.ObjectId(item.medicineId),
        batchId: new Types.ObjectId(item.batchId),
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        unitCost: item.unitCost,
        subtotal: item.subtotal,
        discount: item.discount,
        taxableAmount: item.taxableAmount,
        vatAmount: item.vatAmount,
        totalAmount: item.totalAmount,
        lineCost: item.lineCost,
      })),
      units: plan.units,
      subtotal: plan.subtotal,
      discount: plan.discount,
      taxableAmount: plan.taxableAmount,
      vatAmount: plan.vatAmount,
      totalAmount: plan.totalAmount,
      totalCost: plan.totalCost,
    });

    sale.returnedUnits = (sale.returnedUnits ?? 0) + plan.units;
    sale.returnedDiscount = round2((sale.returnedDiscount ?? 0) + plan.discount);
    sale.returnedTaxable = round2((sale.returnedTaxable ?? 0) + plan.taxableAmount);
    sale.returnedVat = round2((sale.returnedVat ?? 0) + plan.vatAmount);
    sale.returnedTotal = round2((sale.returnedTotal ?? 0) + plan.totalAmount);
    sale.returnedCost = round2((sale.returnedCost ?? 0) + plan.totalCost);
    sale.markModified("items");
    sale.markModified("returns");

    await sale.save({ session: session ?? undefined });

    return {
      id: String(sale._id),
      billNo: sale.billNo,
      units: plan.units,
      totalAmount: plan.totalAmount,
      restored,
      unreturned,
    };
  });
}
