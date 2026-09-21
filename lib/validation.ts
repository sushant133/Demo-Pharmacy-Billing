import { z } from "zod";

import {
  MEDICINE_UNITS,
  PAYMENT_MODES,
  SUPPLIER_PAYMENT_METHODS,
} from "@/lib/constants";
import { REFUND_METHODS, RETURN_REASONS } from "@/lib/return-eligibility";
import { PURCHASE_RETURN_REASONS } from "@/lib/purchase-return";
import { ADJUSTMENT_REASONS, WRITE_OFF_REASONS } from "@/lib/movement-kinds";
import { EXPENSE_CATEGORIES, EXPENSE_METHODS } from "@/lib/expense-categories";
import { DEFAULT_PRINT_TEMPLATE, PRINT_TEMPLATE_IDS } from "@/lib/print-templates";
import { ASSIGNABLE_ROLES } from "@/lib/roles";

/**
 * Zod schemas shared between client forms and API route handlers.
 *
 * One definition means a field cannot drift between what the form accepts and
 * what the server enforces, and the client gets the same error copy the API
 * would have produced.
 */

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id.");

/** Accepts YYYY-MM-DD (what <input type="date"> submits) or an ISO datetime. */
export const dateSchema = z
  .string()
  .min(1, "Required.")
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Not a valid date.")
  .transform((value) => new Date(value));

const optionalDateSchema = z
  .union([dateSchema, z.literal("").transform(() => null), z.null()])
  .optional()
  .transform((value) => value ?? null);

/** Number that also accepts the strings an HTML form sends. */
const numberFromInput = (message: string) =>
  z.coerce.number({ invalid_type_error: message });

/**
 * An optional money field: a non-negative number, or null when left blank.
 *
 * Blank has to survive as null rather than collapsing to 0, because 0 is a
 * price somebody could genuinely mean and "not filled in" is not the same
 * answer as "free".
 */
const optionalMoneySchema = (message: string) =>
  z
    .union([
      /*
        The blank branches come first, and the order is load-bearing.

        `z.coerce.number("")` is 0, not NaN, so a number branch placed above
        these would happily match an empty cell and record a price of zero -
        turning "not filled in" into "free" on every import row that left the
        MRP blank. Zod tries a union's options in order, so the literal has to
        win first. Same shape as `reorderLevel` below, for the same reason.
      */
      z.literal("").transform(() => null),
      z.null(),
      numberFromInput(message).min(0, "That cannot be negative."),
    ])
    .optional()
    .transform((value) => (value === undefined ? null : value));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Medicine
// ---------------------------------------------------------------------------

export const medicineSchema = z.object({
  name: z.string().trim().min(2, "Medicine name is required.").max(200),
  /**
   * The shop's own code for this line. Blank when it does not use codes.
   *
   * Upper-cased here rather than only in the model, so the form, the API and
   * the database all agree on what was saved - a field normalised in one place
   * only is a field that reads back differently from what was typed.
   */
  sku: z
    .string()
    .trim()
    .max(40, "A medicine code can be at most 40 characters.")
    .default("")
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => value === "" || /^[A-Z0-9][A-Z0-9._/-]*$/.test(value),
      "Use letters, numbers, dot, dash, slash or underscore - no spaces.",
    ),
  genericName: z.string().trim().max(200).default(""),
  saltComposition: z.string().trim().max(300).default(""),
  manufacturer: z.string().trim().max(200).default(""),
  category: z.string().trim().max(80).default("Other"),
  unit: z.enum(MEDICINE_UNITS).default("tablet"),
  packSize: z.string().trim().max(60).default(""),
  /** The code on the pack, as a scanner reads it. Blank when there is none. */
  barcode: z.string().trim().max(60).default(""),
  unitsPerStrip: z
    .union([
      numberFromInput("Tablets in one strip must be a whole number.")
        .int("Tablets in one strip must be a whole number.")
        .min(1, "A strip has at least 1.")
        .max(1000, "That strip is too large."),
      z.literal("").transform(() => null),
      z.null(),
    ])
    .optional()
    .transform((value) => (value === undefined ? null : value)),
  /**
   * Indicative purchase price and MRP. Blank is a real answer - a shop often
   * files a medicine before it knows what it will cost - so an empty field
   * becomes null rather than 0, which would read as "free".
   */
  defaultCostPrice: optionalMoneySchema("Purchase price must be a number."),
  defaultSalePrice: optionalMoneySchema("MRP must be a number."),
  requiresPrescription: z.coerce.boolean().default(false),
  reorderLevel: z
    .union([
      z.literal("").transform(() => null),
      z.null(),
      numberFromInput("Reorder level must be a number.").int().min(0),
    ])
    .optional()
    .transform((value) => (value === undefined ? null : value)),
  isActive: z.coerce.boolean().default(true),
});
export type MedicineInput = z.infer<typeof medicineSchema>;

export const medicineUpdateSchema = medicineSchema.partial();

/**
 * A pasted or uploaded catalogue.
 *
 * The CSV is taken as one string and parsed on the server rather than
 * row-by-row in the browser: the rules that decide whether a row is a valid
 * medicine are the same ones the form uses, and running them in two places is
 * how an import starts accepting rows the API would refuse.
 */
export const medicineImportSchema = z.object({
  csv: z
    .string()
    .min(1, "Paste the rows, or choose a file.")
    .max(1_000_000, "That file is too large to import in one go."),
  /** True asks what would happen; false performs it. */
  dryRun: z.coerce.boolean().default(true),
});
export type MedicineImportInput = z.infer<typeof medicineImportSchema>;

export const medicineQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** When "1", each medicine is returned with its total sellable stock. */
  withStock: z.enum(["0", "1"]).default("0"),
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export const batchSchema = z
  .object({
    medicineId: objectIdSchema,
    batchNumber: z.string().trim().min(1, "Batch number is required.").max(60),
    mfgDate: optionalDateSchema,
    expiryDate: dateSchema,
    quantity: numberFromInput("Quantity must be a number.")
      .int("Quantity must be a whole number.")
      .min(0, "Quantity cannot be negative."),
    costPrice: numberFromInput("Cost price must be a number.").min(
      0,
      "Cost price cannot be negative.",
    ),
    salePrice: numberFromInput("Sale price must be a number.").min(
      0,
      "Sale price cannot be negative.",
    ),
    supplierId: z
      .union([objectIdSchema, z.literal(""), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    notes: z.string().trim().max(500).default(""),
  })
  .refine(
    (data) => !data.mfgDate || data.mfgDate.getTime() <= data.expiryDate.getTime(),
    { message: "Expiry date must be after the manufacturing date.", path: ["expiryDate"] },
  );
export type BatchInput = z.infer<typeof batchSchema>;

/** Update form: same fields, all optional, medicine cannot be reassigned. */
export const batchUpdateSchema = z
  .object({
    batchNumber: z.string().trim().min(1).max(60).optional(),
    mfgDate: optionalDateSchema,
    expiryDate: dateSchema.optional(),
    quantity: numberFromInput("Quantity must be a number.").int().min(0).optional(),
    costPrice: numberFromInput("Cost price must be a number.").min(0).optional(),
    salePrice: numberFromInput("Sale price must be a number.").min(0).optional(),
    supplierId: z
      .union([objectIdSchema, z.literal(""), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    notes: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) =>
      !data.mfgDate ||
      !data.expiryDate ||
      data.mfgDate.getTime() <= data.expiryDate.getTime(),
    { message: "Expiry date must be after the manufacturing date.", path: ["expiryDate"] },
  );

export const batchQuerySchema = z.object({
  medicineId: objectIdSchema.optional(),
  q: z.string().trim().max(120).optional(),
  /** "in-stock" hides sold-out lots; "expired" shows only dead stock. */
  status: z.enum(["all", "in-stock", "expired", "expiring"]).default("all"),
  /**
   * "1" reads the lots the till would actually dispense: the selling branch
   * only, and nothing already sold out. The POS batch picker must not offer a
   * lot sitting at another outlet, because FEFO will never reach it.
   */
  till: z.enum(["0", "1"]).default("0"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const saleItemInputSchema = z.object({
  medicineId: objectIdSchema,
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .positive("Quantity must be at least 1."),
  /**
   * A lot the counter picked instead of letting FEFO choose.
   *
   * Optional, and never trusted: the allocator draws from it first but still
   * refuses it if it has expired or emptied, so a hand-picked batch cannot
   * dispense anything the automatic path would have blocked.
   */
  batchId: z
    .union([objectIdSchema, z.literal(""), z.null()])
    .transform((value) => (value ? value : null))
    .optional(),
});

export const createSaleSchema = z.object({
  items: z
    .array(saleItemInputSchema)
    .min(1, "Add at least one medicine to the bill."),
  customerId: z
    .union([objectIdSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  customerName: z.string().trim().max(160).default(""),
  customerPan: z
    .string()
    .trim()
    .max(9)
    .regex(/^$|^\d{9}$/, "Buyer PAN must be 9 digits.")
    .optional(),
  customerAddress: z.string().trim().max(300).optional(),
  customerPhone: z.string().trim().max(30).optional(),
  discount: z.coerce.number().min(0, "Discount cannot be negative.").default(0),
  /**
   * A percentage of the subtotal, 0-100. When present it decides the rupee
   * discount, because only the server knows what the lines actually came to.
   */
  discountPercent: z.coerce
    .number()
    .min(0, "Discount percentage cannot be negative.")
    .max(100, "A discount cannot exceed 100% of the bill.")
    .default(0),
  paymentMode: z.enum(PAYMENT_MODES).default("cash"),
  /**
   * What the customer handed over. Above the total it is change owed back;
   * below it, a balance the shop is carrying. Zero means "not recorded",
   * which is how every bill written before the till asked reads.
   */
  amountReceived: z.coerce
    .number()
    .min(0, "Amount received cannot be negative.")
    .default(0),
  note: z.string().trim().max(300).default(""),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

/** Same input as a sale, used by the POS to preview FEFO picks and totals. */
export const quoteSaleSchema = z.object({
  items: z.array(saleItemInputSchema).min(1),
  discount: z.coerce.number().min(0).default(0),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
});

/**
 * Money taken against a bill after it left the counter - settling a credit or
 * part-paid sale. `credit` is not a method here: receiving payment is the act
 * of clearing credit, not of extending more of it.
 */
export const receiveSalePaymentSchema = z.object({
  amount: z.coerce
    .number()
    .positive("Enter an amount greater than zero.")
    .max(10_000_000, "That amount looks wrong."),
  method: z.enum(PAYMENT_MODES).refine((mode) => mode !== "credit", {
    message: "Choose how the money was received.",
  }),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});
export type ReceiveSalePaymentInput = z.infer<typeof receiveSalePaymentSchema>;

/**
 * A void returns stock and removes a bill from every financial figure, so it
 * carries a written reason for the same audit reason a GRN cancellation does.
 */
export const voidSaleSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the void is auditable.")
    .max(300),
});

export const returnSaleItemSchema = z.object({
  lineIndex: z.coerce.number().int().min(0, "That item is not on this bill."),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .positive("Quantity must be at least 1."),
});

export const returnSaleSchema = z.object({
  items: z
    .array(returnSaleItemSchema)
    .min(1, "Choose at least one medicine to return."),
  /**
   * Why it came back, from a fixed list. Free text alone made every return
   * read differently, which is no use when someone later asks how much is
   * being handed back for wrong dispensing versus changed minds.
   */
  reasonCode: z.enum(
    RETURN_REASONS.map((reason) => reason.code) as [string, ...string[]],
    { message: "Choose why the medicine is coming back." },
  ),
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the return is auditable.")
    .max(300),
  /**
   * The counter's attestation that the goods passed the physical check.
   *
   * Refused rather than defaulted: no record can tell whether a seal is
   * intact, so the only honest source is a person confirming they looked,
   * and the confirmation is stored with the return.
   */
  conditionConfirmed: z.literal(true, {
    message:
      "Confirm the medicine is sealed, undamaged and in its original packaging.",
  }),
  /**
   * How the money went back.
   *
   * Defaulted rather than required, so a client written before this field
   * existed still records a return rather than failing validation - the
   * refund itself is what matters, and cash is what a counter does by
   * default. Whether `adjust` is *allowed* depends on the bill, so that is
   * checked in the service where the balance is known.
   */
  refundMethod: z
    .enum(
      REFUND_METHODS.map((method) => method.code) as [string, ...string[]],
      { message: "Choose how the refund is being given." },
    )
    .default("cash"),
});
export type ReturnSaleInput = z.infer<typeof returnSaleSchema>;

// ---------------------------------------------------------------------------
// Purchase returns (debit notes)
// ---------------------------------------------------------------------------

const purchaseReturnItemSchema = z.object({
  lineIndex: z.coerce.number().int().min(0),
  quantity: z.coerce
    .number()
    .int("Return quantities must be whole units.")
    .min(0),
});

/**
 * Goods going back to the supplier.
 *
 * Deliberately *not* the shape of `returnSaleSchema`, in one respect: there is
 * no `conditionConfirmed`. A customer return needs somebody to attest the box
 * is still sealed, because the units are about to go back on a shelf and be
 * dispensed to the next patient. These units are leaving the building, so
 * there is nothing to attest to and asking would be a tick-box that means
 * nothing.
 */
export const purchaseReturnSchema = z.object({
  items: z
    .array(purchaseReturnItemSchema)
    .min(1, "Choose at least one line to send back."),
  reasonCode: z.enum(
    PURCHASE_RETURN_REASONS.map((reason) => reason.code) as [
      string,
      ...string[],
    ],
    { message: "Choose why the goods are going back." },
  ),
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the debit note is auditable.")
    .max(300),
  /** Blank until the supplier issues their own credit note against it. */
  creditNoteNo: z.string().trim().max(60).default(""),
});
export type PurchaseReturnInput = z.infer<typeof purchaseReturnSchema>;

export const salesQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const lowStockQuerySchema = z.object({
  threshold: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const expiringQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(3650).optional(),
  /** Include lots that already expired (default: only future expiries). */
  includeExpired: z.enum(["0", "1"]).default("1"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Business settings
// ---------------------------------------------------------------------------

/**
 * A checkbox, honestly.
 *
 * `z.coerce.boolean()` is JavaScript truthiness: it reads the string "false"
 * as true, because a non-empty string is truthy. That is survivable on a flag
 * nobody serialises, and not survivable on one that decides whether a VAT
 * line prints on a tax invoice. This takes real booleans, and the handful of
 * strings an HTML form or a query string actually sends, and reads the rest
 * as the default.
 */
const checkboxSchema = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string(), z.undefined(), z.null()])
    .transform((value) => {
      if (typeof value === "boolean") return value;
      if (value === undefined || value === null) return fallback;
      const text = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(text)) return true;
      if (["false", "0", "no", "off", ""].includes(text)) return false;
      return fallback;
    })
    .default(fallback);

/**
 * A nine-digit Nepali tax number: a PAN, or the VAT number that is usually
 * the same thing. Anything else on a tax invoice is a typo that the IRD, not
 * the shop, will find first.
 */
const taxNumberSchema = (label: string) =>
  z
    .string()
    .trim()
    .max(30)
    .default("")
    .refine((value) => value === "" || /^\d{9}$/.test(value), label);

/**
 * The shop's own details, as the Settings screen submits them.
 *
 * Deliberately *not* here: the trading name, registered name, PAN, VAT
 * number, company registration and drug licence. Those are the business's
 * registered identity, superadmin sets them on the pharmacy record, and the
 * Settings screen shows them read-only. Leaving them out of this schema is
 * what makes that a rule rather than a convention - a hand-rolled request
 * carrying a PAN cannot talk its way past a field the parser does not have.
 *
 * Nothing that remains is required: a pharmacy setting the system up should
 * not be blocked at the first screen for want of a line it has to go and
 * look up.
 */
export const settingsSchema = z.object({
  /** Entered as a percentage, stored as a fraction. */
  vatRate: numberFromInput("VAT rate must be a number.")
    .min(0, "VAT rate cannot be negative.")
    .max(100, "VAT rate is a percentage, so it cannot exceed 100.")
    .default(13),

  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  altPhone: z.string().trim().max(40).default(""),
  email: z
    .union([
      z.string().trim().toLowerCase().email("Enter a valid email address."),
      z.literal(""),
    ])
    .default(""),
  website: z.string().trim().max(160).default(""),

  billTerms: z.string().trim().max(400).default(""),
  billFooterNote: z.string().trim().max(400).default(""),
  medicineCategories: z
    .array(z.string().trim().min(1, "Category name is required.").max(80))
    .max(50, "Fifty extra categories is enough.")
    .default([]),
});
export type SettingsInput = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const customerSchema = z.object({
  name: z.string().trim().min(2, "Customer name is required.").max(160),
  phone: z.string().trim().max(30).default(""),
  address: z.string().trim().max(300).default(""),
  panNo: z.string().trim().max(30).default(""),
  notes: z.string().trim().max(500).default(""),
});

// ---------------------------------------------------------------------------
// Suppliers (Phase 2)
// ---------------------------------------------------------------------------

export const supplierSchema = z.object({
  name: z.string().trim().min(2, "Supplier name is required.").max(200),
  contactPerson: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z
    .union([z.string().trim().toLowerCase().email("Enter a valid email address."), z.literal("")])
    .default(""),
  address: z.string().trim().max(300).default(""),
  panNo: z.string().trim().max(30).default(""),
  paymentTermsDays: numberFromInput("Payment terms must be a number of days.")
    .int()
    .min(0, "Payment terms cannot be negative.")
    .max(365, "Payment terms longer than a year are almost certainly a typo.")
    .default(0),
  openingBalance: numberFromInput("Opening balance must be a number.").default(0),
  notes: z.string().trim().max(500).default(""),
  isActive: z.coerce.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const supplierUpdateSchema = supplierSchema.partial();

export const supplierQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["all", "active", "inactive", "owing"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Purchases / GRN (Phase 2)
// ---------------------------------------------------------------------------

export const purchaseItemSchema = z.object({
  medicineId: objectIdSchema,
  batchNumber: z.string().trim().min(1, "Batch number is required.").max(60),
  mfgDate: optionalDateSchema,
  expiryDate: dateSchema,
  quantity: numberFromInput("Quantity must be a number.")
    .int("Quantity must be a whole number.")
    .min(0, "Quantity cannot be negative."),
  /** "10 + 2 free" schemes: units received but not billed. */
  freeQuantity: numberFromInput("Free quantity must be a number.")
    .int("Free quantity must be a whole number.")
    .min(0, "Free quantity cannot be negative.")
    .default(0),
  costPrice: numberFromInput("Cost price must be a number.").min(
    0,
    "Cost price cannot be negative.",
  ),
  salePrice: numberFromInput("Sale price must be a number.").min(
    0,
    "Sale price cannot be negative.",
  ),
  discount: numberFromInput("Line discount must be a number.")
    .min(0, "Line discount cannot be negative.")
    .default(0),
  /**
   * When true, posting also writes this sale price onto every in-stock lot
   * of the same medicine at the receiving branch.
   */
  applySalePriceToStock: z.coerce.boolean().optional(),
});

export const purchaseSchema = z
  .object({
    supplierId: objectIdSchema,
    invoiceNo: z.string().trim().max(60).default(""),
    invoiceDate: optionalDateSchema,
    receivedDate: dateSchema,
    items: z.array(purchaseItemSchema).min(1, "Add at least one item to the purchase."),
    discount: numberFromInput("Discount must be a number.")
      .min(0, "Discount cannot be negative.")
      .default(0),
    otherCharges: numberFromInput("Other charges must be a number.")
      .min(0, "Other charges cannot be negative.")
      .default(0),
    vatRate: numberFromInput("VAT rate must be a number.")
      .min(0)
      .max(1, "VAT rate is a fraction, e.g. 0.13 for 13%.")
      .default(0),
    notes: z.string().trim().max(500).default(""),
    /**
     * Credit period for this delivery, overriding the supplier's default.
     *
     * Blank means "use the supplier's terms", which is what almost every
     * delivery wants. A one-off 60-day arrangement on a single invoice should
     * not require editing the supplier record and then remembering to put it
     * back.
     */
    creditDays: z
      .union([
        z.literal("").transform(() => null),
        z.null(),
        numberFromInput("Credit days must be a number.")
          .int("Credit days must be a whole number.")
          .min(0)
          .max(365, "That is longer than any supplier term."),
      ])
      .optional()
      .transform((value) => (value === undefined ? null : value)),
    /**
     * Money handed over as the goods were received.
     *
     * Only meaningful when the purchase is posted: a draft is not yet a
     * liability, so paying against one would record money leaving the shop
     * for a delivery the system does not believe happened. Carried on the
     * input rather than stored on the draft for the same reason - it is an act
     * performed at posting, not a property of the document.
     */
    payment: z
      .object({
        amount: numberFromInput("Paid amount must be a number.").min(
          0,
          "Paid amount cannot be negative.",
        ),
        method: z.enum(SUPPLIER_PAYMENT_METHODS).default("cash"),
        reference: z.string().trim().max(120).default(""),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.payment && data.payment.amount < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Paid amount cannot be negative.",
        path: ["payment", "amount"],
      });
    }

    /*
      Two lines of the same medicine sharing a lot number would post as one
      blended batch, silently averaging two different costs and expiry dates
      into a lot that matches neither delivery line. Caught here so it is
      refused by the API as well as flagged in the form.

      The same lot number under a *different* medicine is fine - lot numbers
      are the manufacturer's, not the shop's, and two makers reuse them freely.
    */
    const seen = new Map<string, number>();
    data.items.forEach((item, index) => {
      const key = `${item.medicineId}|${item.batchNumber.trim().toLowerCase()}`;
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Lot ${item.batchNumber} is already on line ${first + 1} for this medicine. Combine them into one line, or use the lot number actually printed on each pack.`,
          path: ["items", index, "batchNumber"],
        });
      } else {
        seen.set(key, index);
      }
    });

    data.items.forEach((item, index) => {
      if (item.quantity + item.freeQuantity <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A line must receive at least one unit.",
          path: ["items", index, "quantity"],
        });
      }
      if (item.mfgDate && item.mfgDate.getTime() > item.expiryDate.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expiry date must be after the manufacturing date.",
          path: ["items", index, "expiryDate"],
        });
      }
    });
  });
export type PurchaseInput = z.infer<typeof purchaseSchema>;

/**
 * The optional body on `POST /api/purchases/:id/post`.
 *
 * Posting with nothing at all is the common case - the delivery arrives, the
 * stock goes on the shelf, the invoice is settled later - so every field here
 * is optional and an empty body is valid.
 */
export const purchasePostSchema = z.object({
  payment: z
    .object({
      amount: numberFromInput("Paid amount must be a number.").min(
        0,
        "Paid amount cannot be negative.",
      ),
      method: z.enum(SUPPLIER_PAYMENT_METHODS).default("cash"),
      reference: z.string().trim().max(120).default(""),
    })
    .optional(),
});

export const purchaseQuerySchema = z.object({
  supplierId: objectIdSchema.optional(),
  status: z.enum(["all", "draft", "posted", "cancelled"]).default("all"),
  paymentStatus: z.enum(["all", "unpaid", "partial", "paid"]).default("all"),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const cancelPurchaseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the reversal is auditable.")
    .max(300),
});

// ---------------------------------------------------------------------------
// Supplier payments (Phase 2)
// ---------------------------------------------------------------------------

export const supplierPaymentSchema = z.object({
  supplierId: objectIdSchema,
  /** Omit to record an on-account payment against the overall balance. */
  purchaseId: z
    .union([objectIdSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  amount: numberFromInput("Amount must be a number.").positive(
    "Amount must be greater than zero.",
  ),
  method: z.enum(SUPPLIER_PAYMENT_METHODS).default("cash"),
  paidOn: dateSchema,
  reference: z.string().trim().max(120).default(""),
  note: z.string().trim().max(300).default(""),
});
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;

// ---------------------------------------------------------------------------
// Reporting & export (Phase 3)
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportQuerySchema = z.object({
  report: z.string().trim().min(1, "Choose a report."),
  format: z.enum(EXPORT_FORMATS).default("xlsx"),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  /**
   * Which way stock moved. Only the stock-movements report reads it; every
   * other report ignores it rather than failing on an irrelevant parameter.
   */
  direction: z.enum(["in", "out", "both"]).optional(),
});

export const analyticsQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  granularity: z.enum(["day", "week", "month"]).optional(),
  by: z.enum(["profit", "revenue", "units"]).default("profit"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const alertQuerySchema = z.object({
  kind: z.enum(["expiry", "stock", "dead"]).default("expiry"),
  severity: z.string().trim().optional(),
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Branches (Phase 4)
// ---------------------------------------------------------------------------

export const branchSchema = z.object({
  // Lowercased and hyphenated because the code appears in URLs and in the
  // branch-switcher cookie, where a space or a capital would need escaping.
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "Give the branch a short code.")
    .max(30)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Use lowercase letters, numbers and hyphens only.",
    ),
  name: z.string().trim().min(2, "Branch name is required.").max(160),
  address: z.string().trim().max(300).default(""),
  phone: z.string().trim().max(40).default(""),
  /** Blank falls back to the company PAN when the bill is printed. */
  panNo: z.string().trim().max(30).default(""),
  notes: z.string().trim().max(500).default(""),
});
export type BranchInput = z.infer<typeof branchSchema>;

/**
 * A viewing scope: a branch code, or "all". Used by the switcher and by any
 * screen that accepts `?branch=`.
 */
export const branchScopeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(30)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Not a valid branch.");

export const branchScopeBodySchema = z.object({
  branch: branchScopeSchema,
});
export type BranchScopeBody = z.infer<typeof branchScopeBodySchema>;

// ---------------------------------------------------------------------------
// Pharmacies (platform / superadmin)
// ---------------------------------------------------------------------------

/**
 * The paperwork a pharmacy account carries. All of it optional.
 *
 * An account is usually opened from a phone call: a name, a person and a
 * password are enough to have the shop billing this afternoon, and the licence
 * numbers arrive by photograph next week. Making any of these required would
 * only teach whoever is typing to invent a value, and an invented PAN is worse
 * than a blank one - it prints on a tax invoice.
 *
 * Shared by create and update, so a field cannot be validated one way on the
 * way in and another way when it is corrected.
 */
const pharmacyProfileFields = {
  legalName: z.string().trim().max(160).default(""),
  pan: taxNumberSchema("A Nepali PAN is nine digits."),
  /** In Nepal this is usually the PAN itself, so it is checked the same way. */
  vatNumber: taxNumberSchema("A VAT number is nine digits."),
  /** False for a PAN-only business, which leaves VAT off its bills. */
  vatRegistered: checkboxSchema(true),
  /** Company or firm registration. Free-form: the format varies by district. */
  registrationNo: z.string().trim().max(60).default(""),
  /** Department of Drug Administration licence, which every pharmacy needs. */
  drugLicenceNo: z.string().trim().max(60).default(""),
  /** When that licence runs out, so an expiring one can be chased. */
  licenceExpiry: optionalDateSchema,
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z
    .union([
      z.string().trim().toLowerCase().email("Enter a valid email address."),
      z.literal(""),
    ])
    .default(""),
  ownerPhone: z.string().trim().max(40).default(""),
  /**
   * Nepali citizenship numbers are district-formatted - "12-01-75-01234" and
   * "075/76-1234" are both real - so only the shape is checked, never a
   * pattern that would reject a genuine document.
   */
  ownerCitizenshipNo: z
    .string()
    .trim()
    .max(40)
    .default("")
    .refine(
      (value) => value === "" || /^[0-9A-Za-z/\-\s.]+$/.test(value),
      "Use digits, letters, hyphens and slashes only.",
    ),
  notes: z.string().trim().max(500).default(""),
};

export const createPharmacySchema = z.object({
  ...pharmacyProfileFields,
  name: z.string().trim().min(2, "Pharmacy name is required.").max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(40)
    .regex(
      /^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers and hyphens only.",
    )
    .optional()
    .transform((value) => value || undefined),
  ownerName: z.string().trim().min(2, "Owner name is required.").max(120),
  ownerEmail: z.string().trim().toLowerCase().email("Enter a valid email address."),
  ownerPassword: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password is too long."),
  /** The paper on the counter. Changed later from the pharmacy's own page. */
  printTemplate: z.enum(PRINT_TEMPLATE_IDS).default(DEFAULT_PRINT_TEMPLATE),
});
export type CreatePharmacyInput = z.infer<typeof createPharmacySchema>;

/**
 * Correcting the platform's record of a shop.
 *
 * The owner login is deliberately absent. Changing who can sign in is its own
 * action with its own route, so it cannot happen as a side effect of fixing a
 * typo in an address.
 */
export const updatePharmacySchema = z.object({
  ...pharmacyProfileFields,
  name: z.string().trim().min(2, "Pharmacy name is required.").max(160),
});
export type UpdatePharmacyInput = z.infer<typeof updatePharmacySchema>;

/** Renaming the owner, or moving their login to a different email. */
export const updateOwnerSchema = z.object({
  ownerName: z.string().trim().min(2, "Owner name is required.").max(120),
  ownerEmail: z.string().trim().toLowerCase().email("Enter a valid email address."),
});
export type UpdateOwnerInput = z.infer<typeof updateOwnerSchema>;

/**
 * Suspending or restoring a shop's access.
 *
 * The reason is optional but asked for: three months later, "why is this shop
 * locked out?" is a question only the audit trail can answer.
 */
export const pharmacyStatusSchema = z.object({
  reason: z.string().trim().max(300).default(""),
});
export type PharmacyStatusInput = z.infer<typeof pharmacyStatusSchema>;

/**
 * Deleting a pharmacy and everything it owns.
 *
 * `confirm` must be the shop's own short code, typed by hand. Nothing about
 * this action can be undone, so the guard that matters is that it cannot be
 * reached by a mis-click on a page whose other buttons are harmless.
 */
export const deletePharmacySchema = z.object({
  confirm: z.string().trim().min(1, "Type the short code to confirm."),
});
export type DeletePharmacyInput = z.infer<typeof deletePharmacySchema>;

/**
 * Deleting one outlet.
 *
 * Same shape and same reason as above: the branch's own code, typed by hand,
 * so the action cannot be reached by a mis-click in a list of rows that all
 * look alike.
 */
export const deleteBranchSchema = z.object({
  confirm: z.string().trim().min(1, "Type the branch code to confirm."),
});
export type DeleteBranchInput = z.infer<typeof deleteBranchSchema>;

/**
 * Which bill layout a shop's printer can produce.
 *
 * Its own route rather than a field on the profile form: it is a decision
 * about the hardware on the counter, it changes what every future bill looks
 * like, and it wants to be recorded in the platform's history as a deliberate
 * act rather than buried in "details changed".
 */
export const printTemplateSchema = z.object({
  printTemplate: z.enum(PRINT_TEMPLATE_IDS, {
    message: "Choose one of the listed bill templates.",
  }),
});
export type PrintTemplateInput = z.infer<typeof printTemplateSchema>;

export const resetOwnerPasswordSchema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password is too long."),
});

export const pharmacyQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["all", "active", "suspended"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});


// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

/**
 * Correcting a lot's count after a stock-take.
 *
 * The counted figure is asked for, not a delta - that is what the person
 * holding the shelf actually knows, and making them subtract is how a
 * correction becomes a second error. `expectedQuantity` is what the screen
 * showed them; the service guards on it so a sale that went through mid-count
 * cannot be silently undone.
 */
export const adjustStockSchema = z.object({
  batchId: objectIdSchema,
  countedQuantity: numberFromInput("The counted quantity must be a number.")
    .int("Count in whole units.")
    .min(0, "A count cannot be negative.")
    .max(1_000_000, "That count looks wrong."),
  reasonCode: z.enum(ADJUSTMENT_REASONS),
  reason: z.string().trim().max(300).optional(),
  note: z.string().trim().max(300).optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/**
 * Taking units off the shelf for good.
 *
 * Kept apart from an adjustment because the two say different things: an
 * adjustment says the count was wrong, a write-off says the count was right
 * and the stock is gone. A reason is mandatory - the whole point of the record
 * is being able to answer "where did it go?" a year later.
 */
export const writeOffStockSchema = z.object({
  batchId: objectIdSchema,
  quantity: numberFromInput("The quantity must be a number.")
    .int("Write off whole units.")
    .positive("Write off at least one unit.")
    .max(1_000_000, "That quantity looks wrong."),
  reasonCode: z.enum(WRITE_OFF_REASONS),
  reason: z.string().trim().max(300).optional(),
  note: z.string().trim().max(300).optional(),
});
export type WriteOffStockInput = z.infer<typeof writeOffStockSchema>;

/** Moving units of one lot to another branch of the same pharmacy. */
export const transferStockSchema = z.object({
  batchId: objectIdSchema,
  toBranchId: objectIdSchema,
  quantity: numberFromInput("The quantity must be a number.")
    .int("Transfer whole units.")
    .positive("Transfer at least one unit.")
    .max(1_000_000, "That quantity looks wrong."),
  reason: z.string().trim().max(300).optional(),
  note: z.string().trim().max(300).optional(),
});
export type TransferStockInput = z.infer<typeof transferStockSchema>;

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

export const prescriptionItemSchema = z.object({
  medicineId: objectIdSchema,
  /** What the prescriber wrote, verbatim. */
  dosage: z.string().trim().max(200).default(""),
  quantityPrescribed: numberFromInput("The quantity must be a number.")
    .int("Prescribe whole units.")
    .positive("Prescribe at least one unit.")
    .max(100_000, "That quantity looks wrong."),
  notes: z.string().trim().max(300).default(""),
});

/**
 * Filing a prescription.
 *
 * The patient may be a saved customer or a typed name - a script is often
 * written for somebody the shop has never billed, and refusing to file it
 * until they are on the customer register would mean it does not get filed.
 *
 * `validUntil` is optional because not every script carries one, and inventing
 * an expiry for one that does not is how a valid script gets refused at the
 * counter. When it is given it must not precede the date on the script.
 */
export const prescriptionSchema = z
  .object({
    customerId: z
      .union([objectIdSchema, z.literal(""), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    patientName: z.string().trim().min(2, "The patient's name is required.").max(160),
    patientPhone: z.string().trim().max(30).default(""),
    patientAge: z.string().trim().max(30).default(""),
    patientGender: z.enum(["", "male", "female", "other"]).default(""),

    doctorName: z.string().trim().min(2, "The prescriber's name is required.").max(160),
    doctorRegNo: z.string().trim().max(60).default(""),
    hospital: z.string().trim().max(160).default(""),

    issuedOn: dateSchema,
    validUntil: optionalDateSchema,

    items: z
      .array(prescriptionItemSchema)
      .min(1, "List at least one medicine on the prescription."),

    copyHeld: z.coerce.boolean().default(false),
    notes: z.string().trim().max(1000).default(""),
  })
  .refine(
    (data) =>
      !data.validUntil || data.validUntil.getTime() >= data.issuedOn.getTime(),
    {
      message: "A prescription cannot expire before the day it was written.",
      path: ["validUntil"],
    },
  );
export type PrescriptionInput = z.infer<typeof prescriptionSchema>;

/**
 * Handing part or all of a script over.
 *
 * Quantities are per line rather than one total: two lines of the same script
 * are dispensed in different amounts all the time, and a single figure could
 * not say which medicine it referred to.
 */
export const dispensePrescriptionSchema = z.object({
  items: z
    .array(
      z.object({
        lineIndex: numberFromInput("That item is not on this prescription.")
          .int()
          .min(0, "That item is not on this prescription."),
        quantity: numberFromInput("The quantity must be a number.")
          .int("Dispense whole units.")
          .positive("Dispense at least one unit."),
      }),
    )
    .min(1, "Choose at least one medicine to dispense."),
  /** The bill it went out on, where it was rung up at the till. */
  billNo: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});
export type DispensePrescriptionInput = z.infer<typeof dispensePrescriptionSchema>;

/** Withdrawing a script, with a written reason for the same audit reason a void carries one. */
export const cancelPrescriptionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the cancellation is auditable.")
    .max(300),
});

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------

/**
 * A password a shop sets for a colleague.
 *
 * The same floor the platform uses when it resets an owner's password, so a
 * staff login cannot be weaker than the owner login above it. No complexity
 * rule: they demonstrably push people towards "Pharmacy@1", and length is what
 * actually costs an attacker something.
 */
const staffPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password is too long.");

/**
 * The branch a staff member works at. Blank means "not attached to one",
 * which is legitimate for an owner who works across every outlet.
 */
const staffBranchSchema = z
  .union([objectIdSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

/**
 * The role on a staff account.
 *
 * An enum of the assignable roles, never a free string - `superadmin` is not
 * in the list, so "make me a superadmin" fails at the schema rather than
 * relying on a check further in.
 */
const staffRoleSchema = z.enum(ASSIGNABLE_ROLES, {
  errorMap: () => ({ message: "Choose a role for this account." }),
});

export const staffSchema = z.object({
  name: z.string().trim().min(2, "Their name is required.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: staffPasswordSchema,
  role: staffRoleSchema,
  branchId: staffBranchSchema,
});
export type StaffInput = z.infer<typeof staffSchema>;

/**
 * Editing a colleague. Deliberately not `staffSchema.partial()`: a password is
 * changed through its own route, so that a careless PATCH cannot reset one.
 */
export const staffUpdateSchema = z.object({
  name: z.string().trim().min(2, "Their name is required.").max(120).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .optional(),
  role: staffRoleSchema.optional(),
  /*
    Three states, not two, which is why this cannot reuse `staffBranchSchema`.

    Absent means "leave the branch alone"; an empty string means "detach them
    from it". Collapsing both to null - which the create schema does, correctly,
    because there is nothing to leave alone - would make renaming somebody
    silently unassign the outlet they work at.
  */
  branchId: z
    .union([objectIdSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === "" || value === null ? null : value,
    ),
});
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>;

export const staffPasswordResetSchema = z.object({
  password: staffPasswordSchema,
});

export const staffActiveSchema = z.object({
  isActive: z.coerce.boolean(),
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * A running cost that is not stock.
 *
 * `paidOn` is asked for rather than assumed to be today: expenses are
 * routinely entered a week later off a pile of receipts, and stamping them all
 * with the day they were typed would put January's rent in February's books.
 */
export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z
    .string()
    .trim()
    .min(2, "Say what the money was for.")
    .max(200),
  payee: z.string().trim().max(160).default(""),
  amount: numberFromInput("Amount must be a number.")
    .positive("Amount must be greater than zero.")
    .max(100_000_000, "That amount looks wrong."),
  method: z.enum(EXPENSE_METHODS).default("cash"),
  paidOn: dateSchema,
  reference: z.string().trim().max(120).default(""),
  note: z.string().trim().max(300).default(""),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseUpdateSchema = expenseSchema.partial();
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;
