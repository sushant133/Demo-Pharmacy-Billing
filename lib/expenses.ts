import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { branchForWrite } from "@/lib/branches";
import { branchFilter, type BranchScope } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { round2 } from "@/lib/sale-payment";
import { pharmacyFilter } from "@/lib/tenant";
import { Expense } from "@/models/Expense";
import type { ExpenseCategory } from "@/lib/expense-categories";
import type { SessionUser } from "@/lib/session";
import type { ExpenseInput, ExpenseUpdateInput } from "@/lib/validation";

/**
 * Running costs: rent, salaries, electricity - the things that are not stock.
 *
 * Plain create/edit/delete rather than the append-only ledgers used for stock
 * and payments, and that is a deliberate difference. A stock movement or a
 * receipt is a claim about something that physically happened, so it is
 * corrected by a reversing entry that leaves the original readable. An expense
 * row is a piece of bookkeeping: a mistyped electricity bill is a typo, not an
 * event, and a "correcting entry" for it would only make the category totals
 * harder to read.
 *
 * Every write is scoped by pharmacy, so an id guessed from another shop reads
 * as "no such expense".
 */

export interface ExpenseTotals {
  total: number;
  count: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number; count: number }>;
}

export async function createExpense(
  user: SessionUser,
  input: ExpenseInput,
): Promise<{ id: string; amount: number }> {
  await connectDB();

  // Attributed to the outlet being worked at, not to the pharmacy as a whole:
  // rent is a cost of one shop, and a chain that could not split it would
  // learn nothing from the figure.
  const branch = await branchForWrite(user);

  const expense = await Expense.create({
    ...pharmacyFilter(user),
    branchId: branch.id,
    branchName: branch.name,
    category: input.category,
    description: input.description,
    payee: input.payee,
    amount: round2(input.amount),
    method: input.method,
    paidOn: input.paidOn,
    reference: input.reference,
    note: input.note,
    recordedBy: new Types.ObjectId(user.id),
    recordedByName: user.name,
  });

  return { id: String(expense._id), amount: expense.amount };
}

export async function updateExpense(
  user: SessionUser,
  id: string,
  input: ExpenseUpdateInput,
): Promise<{ id: string; amount: number }> {
  await connectDB();

  const update: Record<string, unknown> = { ...input };
  if (input.amount !== undefined) update.amount = round2(input.amount);
  if (Object.keys(update).length === 0) {
    throw ApiError.badRequest("Nothing to change.");
  }

  const updated = await Expense.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw ApiError.notFound("That expense no longer exists.");
  return { id: String(updated._id), amount: updated.amount };
}

export async function deleteExpense(
  user: SessionUser,
  id: string,
): Promise<{ id: string; deleted: true }> {
  await connectDB();

  const result = await Expense.deleteOne({ _id: id, ...pharmacyFilter(user) });
  if (result.deletedCount === 0) {
    throw ApiError.notFound("That expense no longer exists.");
  }

  return { id, deleted: true };
}

/**
 * What was spent over a range, and on what.
 *
 * The split by category is the reason this screen exists: one number for
 * "costs" tells an owner nothing they can act on, whereas seeing that salaries
 * are two thirds of it tells them where to look.
 */
export async function expenseTotals(
  scope: BranchScope,
  start: Date,
  end: Date,
  category?: ExpenseCategory | null,
): Promise<ExpenseTotals> {
  await connectDB();

  const match: Record<string, unknown> = {
    ...branchFilter(scope),
    paidOn: { $gte: start, $lt: end },
  };
  if (category) match.category = category;

  const rows = await Expense.aggregate<{
    _id: ExpenseCategory;
    amount: number;
    count: number;
  }>([
    { $match: match },
    { $group: { _id: "$category", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    { $sort: { amount: -1 } },
  ]);

  return {
    total: round2(rows.reduce((sum, row) => sum + row.amount, 0)),
    count: rows.reduce((sum, row) => sum + row.count, 0),
    byCategory: rows.map((row) => ({
      category: row._id,
      amount: round2(row.amount),
      count: row.count,
    })),
  };
}
