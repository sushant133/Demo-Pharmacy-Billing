/**
 * Bring the database's indexes in line with what the schemas declare.
 *
 *   npm run sync:indexes
 *
 * Connections are opened with `autoIndex: false` so boot stays fast, which
 * means a newly declared index does not exist until something asks for it.
 * Until now the only things that asked were `npm run seed` and the pharmacy
 * backfill - both one-off, and neither one you would run against a shop that
 * is already trading.
 *
 * So an index added after go-live was silently absent: the medicine-code
 * uniqueness rule, for instance, would be enforced by the form and by nothing
 * underneath it, and two staff saving at once could both succeed. This is the
 * supported way to apply one without re-seeding.
 *
 * `syncIndexes` also drops indexes the schemas no longer declare, so it is the
 * whole state rather than an addition - safe to re-run, and it reports what it
 * changed.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { syncTenantIndexes } from "../lib/indexes";

async function main() {
  await connectDB();
  console.log("Syncing indexes to the current schemas…\n");

  await syncTenantIndexes();

  // Read the result back rather than trusting the call, because "it did not
  // throw" is not the same as "the unique rule is now in place".
  const medicine = mongoose.connection.collection("medicines");
  const indexes = await medicine.indexes();
  const names = indexes.map((index) => index.name).sort();

  console.log("medicines:");
  for (const name of names) console.log(`  ${name}`);

  const hasSku = indexes.some(
    (index) => index.key && "sku" in index.key && index.unique,
  );
  console.log(
    hasSku
      ? "\nMedicine codes are now unique per pharmacy."
      : "\nWarning: the unique medicine-code index is still missing.",
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
