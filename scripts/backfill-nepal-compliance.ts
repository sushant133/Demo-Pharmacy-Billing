/**
 * One-off clean-up after the Nepal compliance review.
 *
 *   npx tsx scripts/backfill-nepal-compliance.ts                       report only
 *   npx tsx scripts/backfill-nepal-compliance.ts --apply               write the changes
 *   npx tsx scripts/backfill-nepal-compliance.ts --apply --pharmacy=my-slug
 *
 * Writes two things:
 *
 *   - Marks catalogue lines VAT exempt, except categories that normally carry
 *     VAT (`defaultVatExempt`). Those are listed so someone can check them, as
 *     is anything that sits in "Other": the VAT schedule is the shop's to apply.
 *   - Clears a branch PAN that is not nine digits. Bills already refuse to print
 *     one; this stops the branch form asking to have it corrected.
 *
 * Reports, and does not touch, what only a person can decide: a VAT-registered
 * shop with its rate at 0%, a missing PAN or DDA licence, a bad pharmacy PAN.
 *
 * Bills already issued are never changed: each one froze its own VAT at the
 * time, and an issued invoice must not move.
 *
 * Safe to run twice: the catalogue step runs once per pharmacy and records that
 * it did, because a medicine marked taxable afterwards is the shop's own decision
 * and must not be reversed. --force repeats it, at the cost of those decisions.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { defaultVatExempt } from "../lib/constants";
import { Branch } from "../models/Branch";
import { Medicine } from "../models/Medicine";
import { Pharmacy } from "../models/Pharmacy";
import { Setting } from "../models/Setting";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const ONLY = process.argv.find((arg) => arg.startsWith("--pharmacy="))?.split("=")[1];
const PAN = /^\d{9}$/;

async function main(): Promise<void> {
  await connectDB();

  const pharmacies = await Pharmacy.find(ONLY ? { slug: ONLY } : {})
    .select("name slug pan drugLicenceNo vatRegistered vatExemptBackfilledAt")
    .lean();
  if (pharmacies.length === 0) {
    console.log(ONLY ? `No pharmacy with slug "${ONLY}".` : "No pharmacies.");
    return;
  }

  console.log(APPLY ? "Applying changes.\n" : "Report only. Run with --apply to write.\n");

  for (const pharmacy of pharmacies) {
    console.log(`${pharmacy.name} (${pharmacy.slug})`);
    const pharmacyId = pharmacy._id;

    const alreadyDone = pharmacy.vatExemptBackfilledAt && !FORCE;
    const notExempt = alreadyDone
      ? []
      : await Medicine.find({ pharmacyId, vatExempt: { $ne: true } })
          .select("_id name category")
          .lean();
    const toExempt = notExempt.filter((medicine) => defaultVatExempt(medicine.category, medicine.name));
    const staysTaxable = notExempt.filter((medicine) => !defaultVatExempt(medicine.category, medicine.name));
    if (alreadyDone) {
      console.log(`  catalogue: already done on ${pharmacy.vatExemptBackfilledAt!.toISOString().slice(0, 10)}, leaving it alone`);
    } else {
      console.log(`  catalogue: ${toExempt.length} to mark VAT exempt, ${staysTaxable.length} left taxable`);
    }
    for (const medicine of staysTaxable.slice(0, 25)) {
      console.log(`    taxable: ${medicine.name} [${medicine.category}]`);
    }
    if (staysTaxable.length > 25) console.log(`    ...and ${staysTaxable.length - 25} more`);
    if (APPLY && toExempt.length > 0) {
      await Medicine.updateMany(
        { _id: { $in: toExempt.map((medicine) => medicine._id) } },
        { $set: { vatExempt: true } },
      );
    }
    if (APPLY && !alreadyDone) {
      await Pharmacy.updateOne({ _id: pharmacyId }, { $set: { vatExemptBackfilledAt: new Date() } });
    }

    const branches = await Branch.find({ pharmacyId }).select("_id name panNo").lean();
    const badBranches = branches.filter((branch) => branch.panNo && !PAN.test(branch.panNo));
    for (const branch of badBranches) {
      console.log(`  branch "${branch.name}": clearing invalid PAN (${branch.panNo?.length} characters)`);
    }
    if (APPLY && badBranches.length > 0) {
      await Branch.updateMany(
        { _id: { $in: badBranches.map((branch) => branch._id) } },
        { $set: { panNo: "" } },
      );
    }

    if (!PAN.test(pharmacy.pan ?? "")) console.log("  ACTION: no valid 9-digit PAN on the pharmacy record");
    if (!pharmacy.drugLicenceNo) console.log("  ACTION: no DDA drug licence on the pharmacy record");
    const setting = await Setting.findOne({ pharmacyId, key: "business" }).select("vatRate").lean();
    if (pharmacy.vatRegistered !== false && setting?.vatRate === 0) {
      console.log("  ACTION: VAT registered but the rate is 0%. Taxable items are being billed with no VAT");
    }
    console.log("");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
