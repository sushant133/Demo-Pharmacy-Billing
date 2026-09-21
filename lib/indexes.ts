import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Customer } from "@/models/Customer";
import { Expense } from "@/models/Expense";
import { Medicine } from "@/models/Medicine";
import { Pharmacy } from "@/models/Pharmacy";
import { PlatformEvent } from "@/models/PlatformEvent";
import { Prescription } from "@/models/Prescription";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Setting } from "@/models/Setting";
import { StockMovement } from "@/models/StockMovement";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import { User } from "@/models/User";

/**
 * Rebuild declared indexes and drop ones the schemas no longer list.
 *
 * Connection setup sets `autoIndex: false` so boot stays fast; seed and the
 * pharmacy backfill call this after the tenant fields exist so unique rules
 * become per-pharmacy rather than global.
 */
export async function syncTenantIndexes(): Promise<void> {
  await Promise.all([
    Pharmacy.syncIndexes(),
    // Not a tenant collection, but it is read by date on every platform
    // screen and nothing else would ever build its index.
    PlatformEvent.syncIndexes(),
    User.syncIndexes(),
    Branch.syncIndexes(),
    Medicine.syncIndexes(),
    Batch.syncIndexes(),
    Sale.syncIndexes(),
    Purchase.syncIndexes(),
    Supplier.syncIndexes(),
    Customer.syncIndexes(),
    Setting.syncIndexes(),
    SupplierPayment.syncIndexes(),
    StockMovement.syncIndexes(),
    Prescription.syncIndexes(),
    Expense.syncIndexes(),
  ]);
}
