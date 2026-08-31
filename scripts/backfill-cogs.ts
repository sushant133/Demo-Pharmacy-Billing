/**
 * One-off migration: fill in cost of goods on sales made before Phase 3.
 *
 *   npx tsx scripts/backfill-cogs.ts          report what would change
 *   npx tsx scripts/backfill-cogs.ts --apply  write the changes
 *
 * Phase 3 records `unitCost` on every sale line at the moment of sale. Bills
 * written before that have zero cost, which would overstate profit on any
 * report covering them.
 *
 * The best available estimate is the batch's current cost price. That is an
 * approximation, and knowingly so: a batch topped up since the sale carries a
 * weighted-average cost that is not exactly what those units cost. It is far
 * closer than zero, and every touched bill is listed so the numbers can be
 * audited rather than trusted blindly.
 */

import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { Batch } from "../models/Batch";
import { Sale } from "../models/Sale";

const APPLY = process.argv.includes("--apply");

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

async function main() {
  await connectDB();
  console.log(APPLY ? "Applying backfill…" : "Dry run - nothing will be written.\n");

  // Only bills that sold something but recorded no cost.
  const sales = await Sale.find({
    $or: [{ totalCost: { $lte: 0 } }, { totalCost: { $exists: false } }],
    taxableAmount: { $gt: 0 },
  }).sort({ createdAt: 1 });

  if (sales.length === 0) {
    console.log("Nothing to backfill - every sale already carries its cost.");
    await mongoose.disconnect();
    return;
  }

  const batchIds = [
    ...new Set(sales.flatMap((sale) => sale.items.map((item) => String(item.batchId)))),
  ];
  const batches = await Batch.find({ _id: { $in: batchIds } })
    .select("_id costPrice batchNumber")
    .lean();
  const costById = new Map(batches.map((batch) => [String(batch._id), batch.costPrice]));

  let updated = 0;
  let unresolved = 0;

  for (const sale of sales) {
    let totalCost = 0;
    let missing = 0;

    for (const item of sale.items) {
      const unitCost = costById.get(String(item.batchId));
      if (unitCost === undefined) {
        // The batch is gone (a cancelled GRN, or a hard delete). Leave the
        // line at zero rather than inventing a figure.
        missing++;
        continue;
      }
      item.unitCost = unitCost;
      item.lineCost = round2(item.quantity * unitCost);
      totalCost += item.lineCost;
    }

    sale.totalCost = round2(totalCost);
    if (missing > 0) unresolved++;

    console.log(
      `  ${sale.billNo}  cost ${sale.totalCost.toFixed(2)}` +
        (missing > 0 ? `  (${missing} line(s) had no batch left)` : ""),
    );

    if (APPLY) await sale.save();
    updated++;
  }

  console.log(`\n${updated} bill(s) ${APPLY ? "updated" : "would be updated"}.`);
  if (unresolved > 0) {
    console.log(
      `${unresolved} bill(s) reference a batch that no longer exists; those lines stay at zero cost.`,
    );
  }
  if (!APPLY) console.log("\nRe-run with --apply to write these changes.");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nBackfill failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
