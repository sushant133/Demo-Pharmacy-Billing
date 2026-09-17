/**
 * One-off migration: give existing bills an explicit payment status.
 *
 *   npx tsx scripts/backfill-payment-status.ts          report what would change
 *   npx tsx scripts/backfill-payment-status.ts --apply  write the changes
 *
 * Until the till started recording what was handed over, there was no such
 * thing as a part-paid bill here: a sale was completed or it was not, and
 * every completed one had been paid in full. So the honest value for an old
 * bill is `amountReceived = totalAmount` and `paymentStatus = "paid"`.
 *
 * This matters more than tidiness. `amountReceived` defaults to 0, and a
 * status derived from 0 would read as "nothing paid" - turning the shop's
 * entire sales history into outstanding debt the moment the dues report is
 * opened. Leaving the field absent is no better: lean() does not apply schema
 * defaults, so the screens would have to guess.
 *
 * Bills that already carry a status are left alone, so this is safe to re-run
 * and cannot overwrite a genuine credit sale recorded since.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { Sale } from "../models/Sale";

const APPLY = process.argv.includes("--apply");

async function main() {
  await connectDB();
  console.log(APPLY ? "Applying backfill…\n" : "Dry run - nothing will be written.\n");

  // Only bills predating the payment ledger: no status recorded at all.
  const filter = { paymentStatus: { $exists: false } };

  const total = await Sale.countDocuments(filter);
  if (total === 0) {
    console.log("Nothing to do: every bill already has a payment status.");
    await mongoose.disconnect();
    return;
  }

  const sample = await Sale.find(filter)
    .select("billNo totalAmount amountReceived voidedAt createdAt")
    .sort({ createdAt: 1 })
    .limit(5)
    .lean();

  console.log(`${total} bill(s) without a payment status. Oldest few:`);
  for (const sale of sample) {
    console.log(
      `  ${sale.billNo}  total=${sale.totalAmount.toFixed(2)}` +
        `  amountReceived=${(sale.amountReceived ?? 0).toFixed(2)}` +
        `  -> paid in full${sale.voidedAt ? " (voided)" : ""}`,
    );
  }

  if (!APPLY) {
    console.log(
      `\nRe-run with --apply to mark all ${total} as paid in full.` +
        "\nNo payments array is written: these predate the ledger, and inventing" +
        "\nreceipts nobody recorded would be worse than leaving it empty.",
    );
    await mongoose.disconnect();
    return;
  }

  // `amountReceived` is set from each bill's own total, so this is one pipeline
  // update rather than a document-by-document loop.
  const result = await Sale.updateMany(filter, [
    {
      $set: {
        amountReceived: "$totalAmount",
        paymentStatus: "paid",
      },
    },
  ]);

  console.log(`Updated ${result.modifiedCount} bill(s).`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
