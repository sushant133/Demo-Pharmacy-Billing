/**
 * One-off migration: turn the old string `branch` label into a real Branch,
 * and attach every user, lot, bill and GRN to it.
 *
 *   npx tsx scripts/backfill-branches.ts          report what would change
 *   npx tsx scripts/backfill-branches.ts --apply  write the changes
 *
 * Phase 4 makes stock physical: a lot belongs to one outlet. Existing
 * documents were written when there was only a "main" label, so they have no
 * `branchId`. This script creates the default outlet if needed and stamps
 * that id onto anything that is missing one.
 *
 * It also drops the old unique index on Batch (medicineId + batchNumber),
 * which is now per-branch.
 */

import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { ensureDefaultBranch } from "../lib/branches";
import { Batch } from "../models/Batch";
import { Branch } from "../models/Branch";
import { Pharmacy } from "../models/Pharmacy";
import { Purchase } from "../models/Purchase";
import { Sale } from "../models/Sale";
import { User } from "../models/User";

const APPLY = process.argv.includes("--apply");

async function stamp(
  model: {
    countDocuments: (filter: object) => Promise<number>;
    updateMany: (filter: object, update: object) => Promise<{ modifiedCount: number }>;
  },
  label: string,
  branchId: mongoose.Types.ObjectId,
  extra: Record<string, unknown> = {},
) {
  const filter = { $or: [{ branchId: { $exists: false } }, { branchId: null }] };
  const missing = await model.countDocuments(filter);
  console.log(`  ${label}: ${missing} without a branch`);
  if (!APPLY || missing === 0) return missing;

  const result = await model.updateMany(filter, { $set: { branchId, ...extra } });
  console.log(`    attached ${result.modifiedCount}`);
  return missing;
}

async function main() {
  await connectDB();
  console.log(APPLY ? "Applying backfill…" : "Dry run - nothing will be written.\n");

  const existing =
    (await Branch.findOne({ isDefault: true, isActive: true })) ??
    (await Branch.findOne({ isActive: true }).sort({ createdAt: 1 }));

  if (!existing && !APPLY) {
    console.log("  would create the default branch (code: main)");
    console.log("  users/batches/sales/purchases without branchId would attach to it.");
    console.log("\nRe-run with --apply to write these changes.");
    await mongoose.disconnect();
    return;
  }

  const pharmacy = await Pharmacy.findOne().sort({ createdAt: 1 });
  if (!pharmacy && APPLY) {
    console.log("No pharmacy exists yet. Run `npm run backfill:pharmacies -- --apply` first.");
    await mongoose.disconnect();
    return;
  }

  const branch = APPLY
    ? await ensureDefaultBranch(pharmacy!._id)
    : existing!;
  console.log(`  default branch: ${branch.code} (${branch.name})  ${branch._id}`);

  await stamp(User, "users", branch._id);
  await stamp(Batch, "batches", branch._id);
  await stamp(Sale, "sales", branch._id, { branchName: branch.name });
  await stamp(Purchase, "purchases", branch._id, { branchName: branch.name });

  if (APPLY) {
    try {
      await Batch.collection.dropIndex("medicineId_1_batchNumber_1");
      console.log("  dropped old Batch unique index medicineId_1_batchNumber_1");
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 27) {
        console.log("  old Batch unique index already gone");
      } else {
        throw error;
      }
    }

    await Batch.syncIndexes();
    console.log("  Batch indexes synced (unique per branch + medicine + lot)");
  } else {
    console.log("\nRe-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nBackfill failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
