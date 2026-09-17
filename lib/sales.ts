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
import { can } from "@/lib/roles";
import { planSaleReturn } from "@/lib/sale-return";
import { settleSale, type PaymentStatus } from "@/lib/sale-payment";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { Batch } from "@/models/Batch";
import { Medicine } from "@/models/Medicine";
import { Sale } from "@/models/Sale";
import { formatBillNo, nextSequence } from "@/models/Counter";
import { Customer } from "@/models/Customer";
import { adToBs, nepaliFiscalYear } from "@/lib/bs-date";
import { localParts } from "@/lib/dates";
import type {
  CreateSaleInput,
  ReceiveSalePaymentInput,
  ReturnSaleInput,
} from "@/lib/validation";
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
  /**
   * The lot the counter pinned this line to, or null when FEFO chose.
   * Echoed back so the cart can tell two lines of the same medicine apart.
   */
  requestedBatchId: string | null;
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
    requestedBatchId: line.requestedBatchId,
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
    const received = round2(Math.max(0, input.amountReceived ?? 0));

    // Letting a bill leave short is extending credit, whichever button the
    // till had lit. The route can only check the *mode* before planning,
    // because until the plan exists there is no total to compare against - so
    // the real check is here, where both figures are known.
    const settlement = settleSale({
      totalAmount: plan.totalAmount,
      amountReceived: received,
    });
    if (settlement.remaining > 0 && !can(user.role, "sale:credit")) {
      throw ApiError.forbidden(
        "You are not allowed to let a bill leave the counter unpaid.",
      );
    }
    const local = localParts(issuedAt);
    const bs = adToBs(local.year, local.month, local.day);
    const fiscalYear = nepaliFiscalYear(bs);
    // Bill numbers restart each Nepali fiscal year, so the high-water mark is
    // read within this pharmacy's own year rather than across its whole history.
    const seq = await nextSequence(
      `${String(pharmacyId)}:sale:${fiscalYear}`,
      session,
      async () => {
        const last = await Sale.findOne({ pharmacyId, fiscalYear })
          .sort({ billSeq: -1 })
          .select("billSeq")
          .session(session)
          .lean();
        return last?.billSeq ?? 0;
      },
    );
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
          amountReceived: received,
          // The till payment is the first entry in the bill's own ledger, so
          // "what has this bill been paid?" has one answer from day one and
          // does not need a special case for the money taken at the counter.
          payments:
            received > 0
              ? [
                  {
                    amount: received,
                    method: input.paymentMode,
                    receivedAt: issuedAt,
                    receivedBy: new Types.ObjectId(user.id),
                    receivedByName: user.name,
                    note: "",
                    reference: "",
                    atTill: true,
                  },
                ]
              : [],
          paymentStatus: settlement.status,
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
// Receiving payment against an outstanding bill
// ---------------------------------------------------------------------------

export interface ReceivedPayment {
  id: string;
  billNo: string;
  totalDue: number;
  paid: number;
  remaining: number;
  status: PaymentStatus;
}

/**
 * Take money against a bill that is not fully paid.
 *
 * This is the other half of a partial or credit sale: without it a due can be
 * created and never cleared. It appends to the bill's own payment ledger
 * rather than editing a balance, so the history of how a debt was settled
 * survives.
 *
 * Deliberately refuses to take more than is owed. Over-tendering at the till
 * is change handed straight back; a customer paying off a due by transfer has
 * no such moment, so an overpayment here is a mistake worth stopping rather
 * than a credit balance the shop then has to track.
 */
export async function receiveSalePayment(
  id: string,
  input: ReceiveSalePaymentInput,
  user: SessionUser,
): Promise<ReceivedPayment> {
  await connectDB();

  const sale = await Sale.findOne({ _id: id, ...pharmacyFilter(user) })
    .select("billNo totalAmount amountReceived returnedTotal voidedAt")
    .lean();
  if (!sale) throw ApiError.notFound("That bill no longer exists.");
  if (sale.voidedAt) {
    throw ApiError.conflict(
      `${sale.billNo} has been voided, so there is nothing left to pay on it.`,
    );
  }

  const before = settleSale({
    totalAmount: sale.totalAmount,
    amountReceived: sale.amountReceived ?? 0,
    returnedTotal: sale.returnedTotal,
  });

  if (before.remaining <= 0) {
    throw ApiError.conflict(`${sale.billNo} is already settled in full.`);
  }

  const amount = round2(input.amount);
  if (amount > before.remaining) {
    throw ApiError.badRequest(
      `Only ${before.remaining.toFixed(2)} is outstanding on ${sale.billNo}.`,
    );
  }

  const receivedAt = new Date();
  const paid = round2(before.paid + amount);
  const after = settleSale({
    totalAmount: sale.totalAmount,
    amountReceived: paid,
    returnedTotal: sale.returnedTotal,
  });

  // Guarded on the balance this was computed against, so two clerks taking the
  // same due at once cannot both succeed and overpay the bill.
  const updated = await Sale.findOneAndUpdate(
    {
      _id: id,
      ...pharmacyFilter(user),
      voidedAt: null,
      amountReceived: sale.amountReceived ?? 0,
    },
    {
      $set: { amountReceived: paid, paymentStatus: after.status },
      $push: {
        payments: {
          amount,
          method: input.method,
          receivedAt,
          receivedBy: new Types.ObjectId(user.id),
          receivedByName: user.name,
          reference: input.reference ?? "",
          note: input.note ?? "",
          atTill: false,
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    throw ApiError.conflict(
      `Another payment was recorded against ${sale.billNo} a moment ago. Open the bill and try again.`,
    );
  }

  return {
    id: String(updated._id),
    billNo: updated.billNo,
    totalDue: after.totalDue,
    paid: after.paid,
    remaining: after.remaining,
    status: after.status,
  };
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
          // A voided bill is owed nothing, so it must stop appearing in the
          // customer's dues. Any money taken against it is refunded at the
          // counter, not carried as a credit balance here.
          paymentStatus: "paid",
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
  /** Where this return sits in the bill's `returns` array - its receipt id. */
  returnIndex: number;
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

    // One instant for the whole return: the expiry check that decides what
    // may come back and the timestamp written on it must not disagree.
    const returnedAt = new Date();

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
            expiryDate: item.expiryDate as unknown as Date,
          })),
          subtotal: sale.subtotal,
          discount: sale.discount,
          vatRate: sale.vatRate,
        },
        input.items,
        returnedAt,
      );
    } catch (error) {
      if (error instanceof FefoError) throw ApiError.badRequest(error.message);
      throw error;
    }

    const pharmacyId = pharmacyObjectId(user);

    /*
      "Reduce what they owe" has to be checked against the bill, not trusted
      from the form. The screen only offers it when something is outstanding,
      but the screen is a convenience: a request naming `adjust` on a bill
      already settled would record that nothing changed hands and nothing was
      owed, leaving the refund owed to a customer with no trace anywhere.

      Measured before the return is applied, which is the state the cashier was
      looking at when they chose.
    */
    const outstandingBefore = round2(
      Math.max(
        0,
        sale.totalAmount -
          (sale.returnedTotal ?? 0) -
          (sale.amountReceived ?? 0),
      ),
    );

    const refundMethod = input.refundMethod ?? "cash";
    if (refundMethod === "adjust" && outstandingBefore <= 0) {
      throw ApiError.badRequest(
        `${sale.billNo} is settled in full, so there is no balance to reduce. Refund the money instead.`,
      );
    }

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
      reasonCode: input.reasonCode,
      reason: input.reason,
      conditionConfirmed: input.conditionConfirmed,
      refundMethod,
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

    // A return lowers what the bill asks for, so a customer who owed money on
    // it may now owe less, or nothing. Recomputed here rather than left for a
    // nightly job: the counter is about to be asked "is this cleared?".
    sale.paymentStatus = settleSale({
      totalAmount: sale.totalAmount,
      amountReceived: sale.amountReceived ?? 0,
      returnedTotal: sale.returnedTotal,
    }).status;

    sale.markModified("items");
    sale.markModified("returns");

    await sale.save({ session: session ?? undefined });

    return {
      id: String(sale._id),
      billNo: sale.billNo,
      // The entry just pushed. Numbering returns by position keeps the receipt
      // addressable without a second id sequence to keep in step.
      returnIndex: sale.returns.length - 1,
      units: plan.units,
      totalAmount: plan.totalAmount,
      restored,
      unreturned,
    };
  });
}
