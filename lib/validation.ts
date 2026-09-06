import { z } from "zod";

import {
  MEDICINE_UNITS,
  PAYMENT_MODES,
  SUPPLIER_PAYMENT_METHODS,
} from "@/lib/constants";

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
  genericName: z.string().trim().max(200).default(""),
  saltComposition: z.string().trim().max(300).default(""),
  manufacturer: z.string().trim().max(200).default(""),
  category: z.string().trim().max(80).default("Other"),
  unit: z.enum(MEDICINE_UNITS).default("tablet"),
  packSize: z.string().trim().max(60).default(""),
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
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason so the return is auditable.")
    .max(300),
});
export type ReturnSaleInput = z.infer<typeof returnSaleSchema>;

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
 * The shop's own details, as the Settings screen submits them.
 *
 * Only the trading name is required: a pharmacy setting the system up should
 * not be blocked at the first screen for want of a licence number it has to go
 * and look up. The PAN is the one field the bill genuinely cannot do without,
 * so its absence is warned about on the invoice itself rather than refused
 * here.
 */
export const settingsSchema = z.object({
  businessName: z.string().trim().min(2, "The pharmacy name is required.").max(160),
  legalName: z.string().trim().max(160).default(""),

  pan: z
    .string()
    .trim()
    .max(30)
    .default("")
    // Nepali PANs are nine digits. Anything else on a tax invoice is a typo
    // that the IRD, not the shop, will find first.
    .refine(
      (value) => value === "" || /^\d{9}$/.test(value),
      "A Nepali PAN is nine digits.",
    ),
  vatRegistered: z.coerce.boolean().default(true),
  vatNumber: z
    .string()
    .trim()
    .max(30)
    .default("")
    .refine(
      (value) => value === "" || /^\d{9}$/.test(value),
      "A VAT number is nine digits.",
    ),
  /** Entered as a percentage, stored as a fraction. */
  vatRate: numberFromInput("VAT rate must be a number.")
    .min(0, "VAT rate cannot be negative.")
    .max(100, "VAT rate is a percentage, so it cannot exceed 100.")
    .default(13),

  drugLicenceNo: z.string().trim().max(60).default(""),
  registrationNo: z.string().trim().max(60).default(""),

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
  })
  .superRefine((data, ctx) => {
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

export const createPharmacySchema = z.object({
  name: z.string().trim().min(2, "Pharmacy name is required.").max(160),
  legalName: z.string().trim().max(160).default(""),
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
  pan: z
    .string()
    .trim()
    .max(30)
    .default("")
    .refine((value) => value === "" || /^\d{9}$/.test(value), "A Nepali PAN is nine digits."),
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  notes: z.string().trim().max(500).default(""),
});
export type CreatePharmacyInput = z.infer<typeof createPharmacySchema>;

export const updatePharmacySchema = z.object({
  name: z.string().trim().min(2, "Pharmacy name is required.").max(160).optional(),
  legalName: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type UpdatePharmacyInput = z.infer<typeof updatePharmacySchema>;

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

