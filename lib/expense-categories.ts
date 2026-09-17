/**
 * What a pharmacy spends money on that is not stock.
 *
 * Kept free of Node-only imports, like lib/roles.ts, so the model, the API,
 * the server screens and the browser form all read one list.
 *
 * The categories are the lines a Nepali retail pharmacy actually has on its
 * books, not a generic accounting chart. A free-text category would produce a
 * ledger nobody can total - "Elec", "electricity", "Electricity bill" as three
 * rows - and the point of recording these at all is to be able to subtract
 * them from gross margin and get a number that means something.
 */

export const EXPENSE_CATEGORIES = [
  "rent",
  "salaries",
  "electricity",
  "water",
  "internet",
  "transport",
  "maintenance",
  "licence",
  "marketing",
  "bank-charges",
  "tax",
  "supplies",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: "Rent",
  salaries: "Salaries and wages",
  electricity: "Electricity",
  water: "Water",
  internet: "Internet and phone",
  transport: "Transport and delivery",
  maintenance: "Repairs and maintenance",
  licence: "Licences and renewals",
  marketing: "Marketing",
  "bank-charges": "Bank charges",
  tax: "Taxes and duties",
  supplies: "Shop supplies",
  other: "Other",
};

/**
 * How the money left the shop.
 *
 * Deliberately the supplier list rather than the till's: an expense is money
 * going out, and "credit" - which the till offers - is not a way of paying a
 * landlord. `adjustment` is kept for a correcting entry.
 */
export const EXPENSE_METHODS = [
  "cash",
  "cheque",
  "bank-transfer",
  "esewa",
  "khalti",
  "adjustment",
] as const;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];

export const EXPENSE_METHOD_LABELS: Record<ExpenseMethod, string> = {
  cash: "Cash",
  cheque: "Cheque",
  "bank-transfer": "Bank transfer",
  esewa: "eSewa",
  khalti: "Khalti",
  adjustment: "Adjustment",
};

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return (
    typeof value === "string" &&
    (EXPENSE_CATEGORIES as readonly string[]).includes(value)
  );
}
