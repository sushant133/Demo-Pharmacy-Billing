/**
 * One-off migration: attach every existing shop document to a pharmacy tenant.
 *
 *   npx tsx scripts/backfill-pharmacies.ts          report what would change
 *   npx tsx scripts/backfill-pharmacies.ts --apply  write the changes
 *
 * Multi-vendor isolation requires `pharmacyId` on every shop record. Installs
 * that predate this change have a single unnamed shop; this script creates
 * that pharmacy (and a superadmin login) and stamps the id onto anything
 * missing one, then rebuilds indexes so uniqueness is per-pharmacy.
 */

import "dotenv/config";
import mongoose from "mongoose";

import bcrypt from "bcryptjs";
import { connectDB } from "../lib/db";
import { syncTenantIndexes } from "../lib/indexes";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { Batch } from "../models/Batch";
import { Branch } from "../models/Branch";
import { Customer } from "../models/Customer";
import { Medicine } from "../models/Medicine";
import { Pharmacy } from "../models/Pharmacy";
import { Purchase } from "../models/Purchase";
import { Sale } from "../models/Sale";
import { Setting } from "../models/Setting";
import { Supplier } from "../models/Supplier";
import { SupplierPayment } from "../models/SupplierPayment";
import { User } from "../models/User";

const APPLY = process.argv.includes("--apply");

async function stamp(
  model: {
    countDocuments: (filter: object) => Promise<number>;
    updateMany: (filter: object, update: object) => Promise<{ modifiedCount: number }>;
  },
  label: string,
  pharmacyId: mongoose.Types.ObjectId,
) {
  const filter = { $or: [{ pharmacyId: { $exists: false } }, { pharmacyId: null }] };
  const missing = await model.countDocuments(filter);
  console.log(`  ${label}: ${missing} without a pharmacy`);
  if (!APPLY || missing === 0) return missing;

  const result = await model.updateMany(filter, { $set: { pharmacyId } });
  console.log(`    attached ${result.modifiedCount}`);
  return missing;
}

async function main() {
  await connectDB();
  console.log(APPLY ? "Applying backfill…" : "Dry run - nothing will be written.\n");

  let pharmacy = await Pharmacy.findOne().sort({ createdAt: 1 });

  if (!pharmacy && !APPLY) {
    console.log("  would create the default pharmacy from current settings");
    console.log("  would create a superadmin login if none exists");
    console.log("  every shop document without pharmacyId would attach to it.");
    console.log("\nRe-run with --apply to write these changes.");
    await mongoose.disconnect();
    return;
  }

  if (!pharmacy) {
    const settings = await Setting.findOne({ key: "business" }).lean();
    const name =
      (settings && "businessName" in settings && typeof settings.businessName === "string"
        ? settings.businessName
        : DEFAULT_SETTINGS.businessName) || "Mantra Pharmacy";

    const [created] = await Pharmacy.create([
      {
        name,
        slug: "mantra-pharmacy",
        status: "active",
        notes: "Created by the pharmacy backfill from the previous single-shop install.",
      },
    ]);
    pharmacy = created!;
    console.log(`  created pharmacy ${pharmacy.name} (${pharmacy._id})`);
  } else {
    console.log(`  using pharmacy ${pharmacy.name} (${pharmacy._id})`);
  }

  const pharmacyId = pharmacy._id;

  await stamp(Branch, "branches", pharmacyId);
  await stamp(Medicine, "medicines", pharmacyId);
  await stamp(Batch, "batches", pharmacyId);
  await stamp(Sale, "sales", pharmacyId);
  await stamp(Purchase, "purchases", pharmacyId);
  await stamp(Supplier, "suppliers", pharmacyId);
  await stamp(Customer, "customers", pharmacyId);
  await stamp(Setting, "settings", pharmacyId);
  await stamp(SupplierPayment, "payments", pharmacyId);

  const unattachedUsers = await User.countDocuments({
    role: { $ne: "superadmin" },
    $or: [{ pharmacyId: { $exists: false } }, { pharmacyId: null }],
  });
  console.log(`  shop users: ${unattachedUsers} without a pharmacy`);
  if (APPLY && unattachedUsers > 0) {
    const result = await User.updateMany(
      {
        role: { $ne: "superadmin" },
        $or: [{ pharmacyId: { $exists: false } }, { pharmacyId: null }],
      },
      { $set: { pharmacyId } },
    );
    console.log(`    attached ${result.modifiedCount}`);
  }

  const owner =
    (await User.findOne({ pharmacyId, role: "admin" }).sort({ createdAt: 1 })) ??
    (await User.findOne({ role: "admin" }).sort({ createdAt: 1 }));
  if (APPLY && owner && !pharmacy.ownerUserId) {
    pharmacy.ownerUserId = owner._id;
    pharmacy.ownerName = owner.name;
    pharmacy.ownerEmail = owner.email;
    await pharmacy.save();
    console.log(`  owner set to ${owner.email}`);
  }

  const superEmail = process.env.SEED_SUPERADMIN_EMAIL ?? "superadmin@mantrapharma.local";
  const existingSuper = await User.findOne({ role: "superadmin" });
  if (!existingSuper) {
    console.log(`  superadmin: none yet (would create ${superEmail})`);
    if (APPLY) {
      await User.create({
        name: "Platform Superadmin",
        email: superEmail,
        passwordHash: await bcrypt.hash(
          process.env.SEED_SUPERADMIN_PASSWORD ?? "Super@123",
          12,
        ),
        role: "superadmin",
      });
      console.log(`    created ${superEmail}  /  Super@123  (change this)`);
    }
  } else {
    console.log(`  superadmin: ${existingSuper.email}`);
  }

  if (APPLY) {
    console.log("  syncing indexes…");
    await syncTenantIndexes();
    console.log("  indexes rebuilt");
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write these changes.");
  } else {
    console.log("\nBackfill complete.");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nBackfill failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
