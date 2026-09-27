/**
 * Create the shared demo/testing pharmacy account.
 *
 *   npx tsx scripts/create-demo-pharmacy.ts
 *
 * Idempotent: does nothing if the demo owner email already exists. The
 * password is fixed and not forced to change, so the login stays usable
 * for demos.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { createPharmacySchema } from "../lib/validation";
import { createPharmacy } from "../lib/pharmacies";
import { User } from "../models/User";
import type { SessionUser } from "../lib/session";

const DEMO = {
  name: "Demo Pharmacy",
  pan: "123456789",
  email: "demo@mantrasphere.com.np",
  password: "Demo@123",
};

async function main() {
  await connectDB();
  const existing = await User.findOne({ email: DEMO.email });
  if (existing) {
    console.log(`${DEMO.email} already exists, nothing to do.`);
    return;
  }

  const superadmin = await User.findOne({ role: "superadmin" }).lean();
  const actor = {
    id: String(superadmin?._id ?? new mongoose.Types.ObjectId()),
    name: superadmin?.name ?? "Platform Superadmin",
  } as SessionUser;

  const input = createPharmacySchema.parse({
    name: DEMO.name,
    slug: "demo-pharmacy",
    pan: DEMO.pan,
    email: DEMO.email,
    ownerName: "Demo Admin",
    ownerEmail: DEMO.email,
    notes: "Demo/testing account.",
  });

  const pharmacy = await createPharmacy(input, actor, DEMO.password);
  await User.updateOne({ email: DEMO.email }, { mustChangePassword: false });

  console.log(`+ ${pharmacy.name} (${DEMO.email} / ${DEMO.password})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
