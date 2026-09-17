import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  EXPENSE_CATEGORIES,
  EXPENSE_METHODS,
  type ExpenseCategory,
  type ExpenseMethod,
} from "@/lib/expense-categories";

export { EXPENSE_CATEGORIES, EXPENSE_METHODS };
export type { ExpenseCategory, ExpenseMethod };

/**
 * One running cost that is not stock.
 *
 * The books here have always run on goods - what was bought, what was sold,
 * what is owed to suppliers - which makes gross margin honest and net profit
 * fiction, because nothing subtracted the cost of keeping the door open. This
 * is the collection that closes that gap.
 *
 * Deliberately not a SupplierPayment. Money paid to a supplier settles an
 * invoice for goods already on the shelf and moves a payable; rent moves
 * nothing and settles nothing. Folding them together would make the payables
 * ledger wrong in order to save a collection.
 */
const expenseSchema = new Schema(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId,
      ref: "Pharmacy",
      required: true,
      index: true,
    },
    /** Which outlet carried the cost. Rent is per shop, not per company. */
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    branchName: { type: String, default: "" },

    category: {
      type: String,
      enum: EXPENSE_CATEGORIES,
      required: true,
      index: true,
    },
    /** What it was for, in the shop's own words. */
    description: { type: String, required: true, trim: true, maxlength: 200 },
    /** Who it was paid to: a landlord, an employee, the utility board. */
    payee: { type: String, trim: true, default: "", maxlength: 160 },

    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: EXPENSE_METHODS, required: true, default: "cash" },
    /** The date the money left, which is not the date it was typed in. */
    paidOn: { type: Date, required: true, index: true },
    /** Cheque number, bill number, transaction id. */
    reference: { type: String, trim: true, default: "", maxlength: 120 },
    note: { type: String, trim: true, default: "", maxlength: 300 },

    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recordedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

// The register reads newest-first within a branch scope and a date range.
expenseSchema.index({ pharmacyId: 1, paidOn: -1 });
expenseSchema.index({ branchId: 1, paidOn: -1 });
// The by-category roll-up behind the summary strip and the profit report.
expenseSchema.index({ pharmacyId: 1, category: 1, paidOn: -1 });

export type ExpenseDoc = InferSchemaType<typeof expenseSchema>;

export const Expense: Model<ExpenseDoc> =
  (models.Expense as Model<ExpenseDoc>) ?? model<ExpenseDoc>("Expense", expenseSchema);
