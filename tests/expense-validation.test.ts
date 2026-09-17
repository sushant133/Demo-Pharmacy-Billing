import { describe, expect, it } from "vitest";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_METHODS,
  EXPENSE_METHOD_LABELS,
  isExpenseCategory,
} from "@/lib/expense-categories";
import { expenseSchema, expenseUpdateSchema } from "@/lib/validation";

const base = {
  category: "rent" as const,
  description: "  Shop rent for Ashadh  ",
  amount: "18000",
  method: "bank-transfer" as const,
  paidOn: "2026-06-15",
};

describe("expenseSchema", () => {
  it("accepts the strings an HTML form actually submits", () => {
    const parsed = expenseSchema.parse(base);
    expect(parsed.amount).toBe(18000);
    expect(parsed.description).toBe("Shop rent for Ashadh");
    expect(parsed.paidOn).toBeInstanceOf(Date);
  });

  /*
    `paidOn` is asked for rather than defaulted to today. Expenses are entered
    a week later off a pile of receipts, and stamping them with the day they
    were typed would put January's rent in February's books.
  */
  it("requires the date the money actually left", () => {
    const { paidOn: _omitted, ...withoutDate } = base;
    expect(expenseSchema.safeParse(withoutDate).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, paidOn: "" }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, paidOn: "not a date" }).success).toBe(
      false,
    );
  });

  it("refuses an amount that is zero, negative or absurd", () => {
    for (const amount of ["0", "-500", "999999999"]) {
      expect(expenseSchema.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(expenseSchema.safeParse({ ...base, amount: "0.01" }).success).toBe(true);
  });

  it("insists on saying what the money was for", () => {
    expect(expenseSchema.safeParse({ ...base, description: "" }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, description: "x" }).success).toBe(false);
  });

  /*
    A fixed list, not free text. "Elec", "electricity" and "Electricity bill"
    as three rows would make the category totals - the whole point of the
    screen - impossible to read.
  */
  it("takes only a known category and a known method", () => {
    expect(expenseSchema.safeParse({ ...base, category: "bribes" }).success).toBe(
      false,
    );
    expect(expenseSchema.safeParse({ ...base, method: "credit" }).success).toBe(
      false,
    );
  });

  it("defaults the optional fields rather than storing undefined", () => {
    const parsed = expenseSchema.parse(base);
    expect(parsed.payee).toBe("");
    expect(parsed.reference).toBe("");
    expect(parsed.note).toBe("");
  });

  it("accepts every category and method the form offers", () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(expenseSchema.safeParse({ ...base, category }).success).toBe(true);
    }
    for (const method of EXPENSE_METHODS) {
      expect(expenseSchema.safeParse({ ...base, method }).success).toBe(true);
    }
  });
});

describe("expenseUpdateSchema", () => {
  it("lets one field be corrected on its own", () => {
    const parsed = expenseUpdateSchema.parse({ amount: "19500" });
    expect(parsed.amount).toBe(19500);
    expect(parsed.category).toBeUndefined();
    expect(parsed.paidOn).toBeUndefined();
  });

  it("still enforces the rules on whatever is sent", () => {
    expect(expenseUpdateSchema.safeParse({ amount: "-1" }).success).toBe(false);
    expect(expenseUpdateSchema.safeParse({ category: "nonsense" }).success).toBe(
      false,
    );
  });
});

describe("expense vocabulary", () => {
  it("gives every category and method a label", () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(EXPENSE_CATEGORY_LABELS[category]).toBeTruthy();
    }
    for (const method of EXPENSE_METHODS) {
      expect(EXPENSE_METHOD_LABELS[method]).toBeTruthy();
    }
  });

  /*
    "credit" is a way of not paying, which is meaningful at a till and
    meaningless for a landlord. Its absence here is deliberate.
  */
  it("does not offer credit as a way of paying an expense", () => {
    expect(EXPENSE_METHODS).not.toContain("credit");
  });

  it("recognises its own categories and nothing else", () => {
    expect(isExpenseCategory("salaries")).toBe(true);
    expect(isExpenseCategory("Salaries")).toBe(false);
    expect(isExpenseCategory(undefined)).toBe(false);
  });
});
