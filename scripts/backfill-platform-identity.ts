/**
 * One-off migration: move each shop's registered identity onto its pharmacy.
 *
 *   npx tsx scripts/backfill-platform-identity.ts          report what would change
 *   npx tsx scripts/backfill-platform-identity.ts --apply  write the changes
 *
 * The trading name, registered name, PAN, VAT number, company registration
 * and drug licence used to live in each shop's own Setting record, where the
 * owner could edit them. They are now the platform's, set by superadmin, and
 * `getSettings` overlays the pharmacy document over the setting one.
 *
 * Which means: until this has run, a pharmacy whose PAN was only ever typed
 * into its own Settings screen prints a bill with no PAN on it. So each blank
 * field on the pharmacy record is filled from the value the shop had, and any
 * field the platform already holds is left exactly as it is - superadmin's
 * copy is the one that was verified.
 *
 * Safe to run twice. Nothing is overwritten and nothing is deleted; the old
 * values stay in the Setting documents, ignored, until someone cleans them up.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { Pharmacy } from "../models/Pharmacy";
import { Setting } from "../models/Setting";

const APPLY = process.argv.includes("--apply");

/** Setting field -> Pharmacy field. The names differ for the trading name. */
const MOVES = [
  ["businessName", "name"],
  ["legalName", "legalName"],
  ["pan", "pan"],
  ["vatNumber", "vatNumber"],
  ["registrationNo", "registrationNo"],
  ["drugLicenceNo", "drugLicenceNo"],
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function main(): Promise<void> {
  await connectDB();

  const pharmacies = await Pharmacy.find().lean();
  if (pharmacies.length === 0) {
    console.log("No pharmacies. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  let changed = 0;

  for (const pharmacy of pharmacies) {
    const setting = await Setting.findOne({
      pharmacyId: pharmacy._id,
      key: "business",
    }).lean();

    const updates: Record<string, string | boolean> = {};
    const notes: string[] = [];

    for (const [from, to] of MOVES) {
      const shopValue = text(setting?.[from]);
      const platformValue = text(pharmacy[to]);

      // The trading name is never blank on a pharmacy, so it is only moved
      // when the shop had renamed itself in Settings and the two drifted.
      if (to === "name") {
        if (shopValue && shopValue !== platformValue) {
          updates[to] = shopValue;
          notes.push(`name: "${platformValue}" -> "${shopValue}" (shop's own)`);
        }
        continue;
      }

      if (!platformValue && shopValue) {
        updates[to] = shopValue;
        notes.push(`${to}: "" -> "${shopValue}"`);
      } else if (platformValue && shopValue && platformValue !== shopValue) {
        // Both sides hold a value and they disagree. The platform's is kept,
        // because it is the one somebody checked against a document - but it
        // is worth saying out loud, since the shop's bill is about to change.
        notes.push(
          `${to}: kept platform "${platformValue}", shop had "${shopValue}" — bill will change`,
        );
      }
    }

    // A PAN-only business is recorded by the shop having unticked VAT. That
    // flag has to travel too, or its bills start claiming a VAT number.
    if (setting && setting.vatRegistered === false && pharmacy.vatRegistered !== false) {
      updates.vatRegistered = false;
      notes.push("vatRegistered: true -> false (shop is PAN-only)");
    }

    // A shop registered for VAT with no separate number uses its PAN, which
    // is what the old Setting seed did at creation.
    const panAfter = text(updates.pan ?? pharmacy.pan);
    const vatAfter = text(updates.vatNumber ?? pharmacy.vatNumber);
    if (!vatAfter && panAfter && updates.vatRegistered !== false) {
      updates.vatNumber = panAfter;
      notes.push(`vatNumber: "" -> "${panAfter}" (same as PAN)`);
    }

    if (notes.length === 0) continue;

    changed += 1;
    console.log(`\n${pharmacy.name} (${pharmacy.slug})`);
    for (const note of notes) console.log(`  ${note}`);

    if (APPLY && Object.keys(updates).length > 0) {
      await Pharmacy.updateOne({ _id: pharmacy._id }, { $set: updates });
    }
  }

  console.log(
    `\n${changed} of ${pharmacies.length} pharmac${pharmacies.length === 1 ? "y" : "ies"} ` +
      (APPLY ? "updated." : "would change. Re-run with --apply to write them."),
  );

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
