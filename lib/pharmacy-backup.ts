import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { slugifyPharmacyName } from "@/lib/tenant";
import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Counter } from "@/models/Counter";
import { Customer } from "@/models/Customer";
import { Expense } from "@/models/Expense";
import { Medicine } from "@/models/Medicine";
import { Pharmacy } from "@/models/Pharmacy";
import { Prescription } from "@/models/Prescription";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Setting } from "@/models/Setting";
import { StockMovement } from "@/models/StockMovement";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
import { User } from "@/models/User";

/**
 * Superadmin dump of one pharmacy's documents.
 *
 * Every collection is filtered by that pharmacy's id (counters by the
 * `${pharmacyId}:` key prefix), so a backup of Himalaya Chemist cannot
 * contain a single Sagarmatha bill, lot or user.
 *
 * Password hashes are omitted: the file is a download, and a leaked dump
 * should not be a table of logins. Restore by creating the owner again or
 * resetting the password from this panel.
 */

export const BACKUP_FORMAT = "mantrapharma-pharmacy-backup";
export const BACKUP_VERSION = 1;

/**
 * Every collection the file carries.
 *
 * This list is the promise the backup makes, so it has to cover everything a
 * pharmacy owns - prescriptions, the stock ledger and expenses included.
 * Leaving one out was survivable while a backup was only ever a copy; it is
 * not now that deleting an account is possible and this file is what somebody
 * is told to take first.
 */
const COLLECTIONS = [
  "users",
  "branches",
  "settings",
  "medicines",
  "batches",
  "customers",
  "suppliers",
  "purchases",
  "payments",
  "sales",
  "prescriptions",
  "movements",
  "expenses",
  "counters",
] as const;

export type BackupCollection = (typeof COLLECTIONS)[number];

export interface PharmacyBackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  pharmacy: Record<string, unknown>;
  counts: Record<BackupCollection, number>;
  data: Record<BackupCollection, unknown[]>;
}

/** JSON-safe value: ObjectIds become hex, Dates become ISO, hashes dropped. */
export function serializeValue(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Types.ObjectId) return String(value);
  if (typeof value === "object" && value !== null && "_bsontype" in value) {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "passwordHash" || key === "__v") continue;
      out[key] = serializeValue(entry);
    }
    return out;
  }
  return value;
}

export function backupFilename(slug: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const handle = slugifyPharmacyName(slug) || "pharmacy";
  return `${handle}-${day}.json`;
}

async function loadAll(
  model: { find: (filter: object) => { lean: () => Promise<unknown[]> } },
  filter: object,
): Promise<unknown[]> {
  const docs = await model.find(filter).lean();
  return docs.map(serializeValue);
}

export async function backupPharmacy(id: string): Promise<{
  filename: string;
  body: string;
}> {
  if (!Types.ObjectId.isValid(id)) {
    throw ApiError.notFound("That pharmacy no longer exists.");
  }

  await connectDB();
  const pharmacyId = new Types.ObjectId(id);
  const pharmacy = await Pharmacy.findById(pharmacyId).lean();
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  const tenant = { pharmacyId };
  const prefix = `${String(pharmacyId)}:`;

  const [
    users,
    branches,
    settings,
    medicines,
    batches,
    customers,
    suppliers,
    purchases,
    payments,
    sales,
    prescriptions,
    movements,
    expenses,
    counters,
  ] = await Promise.all([
    User.find(tenant).select("-passwordHash").lean(),
    loadAll(Branch, tenant),
    loadAll(Setting, tenant),
    loadAll(Medicine, tenant),
    loadAll(Batch, tenant),
    loadAll(Customer, tenant),
    loadAll(Supplier, tenant),
    loadAll(Purchase, tenant),
    loadAll(SupplierPayment, tenant),
    loadAll(Sale, tenant),
    loadAll(Prescription, tenant),
    loadAll(StockMovement, tenant),
    loadAll(Expense, tenant),
    Counter.find({ _id: { $regex: `^${prefix}` } }).lean(),
  ]);

  const data: PharmacyBackupFile["data"] = {
    users: users.map(serializeValue),
    branches,
    settings,
    medicines,
    batches,
    customers,
    suppliers,
    purchases,
    payments,
    sales,
    prescriptions,
    movements,
    expenses,
    counters: counters.map(serializeValue),
  };

  const counts = Object.fromEntries(
    COLLECTIONS.map((key) => [key, data[key].length]),
  ) as Record<BackupCollection, number>;

  const file: PharmacyBackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    pharmacy: serializeValue(pharmacy) as Record<string, unknown>,
    counts,
    data,
  };

  return {
    filename: backupFilename(pharmacy.slug || pharmacy.name),
    body: JSON.stringify(file, null, 2),
  };
}
