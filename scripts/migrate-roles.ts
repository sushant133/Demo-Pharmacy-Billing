/**
 * One-off migration: resolve accounts left on the first role scheme.
 *
 *   npx tsx scripts/migrate-roles.ts          report what would change
 *   npx tsx scripts/migrate-roles.ts --apply  write the changes
 *
 * There have been two role schemes, and the ambiguity between them is the
 * whole reason this script still exists.
 *
 * Under scheme 1, "pharmacist" and "cashier" were folded into admin: they were
 * simply other words for the owner, and anything carrying them was read as an
 * admin. Scheme 2 brings both words back as genuinely narrower roles - a
 * cashier can no longer void a bill or read a margin.
 *
 * So a row still saying `role: "cashier"` with no `roleVersion` is ambiguous:
 * under the scheme it was written in, it meant the owner. The app resolves
 * that in the reader's favour and keeps treating such rows as owners, which is
 * safe for the person but leaves the row saying something it does not mean.
 * This script writes the meaning down: those accounts become an explicit
 * `admin` at `roleVersion: 2`, after which the word on the row is the word the
 * system enforces.
 *
 * Promotion deletes nobody. The people behind those logins are still the
 * people running the shop; they keep their email, their password and the sales
 * history recorded against them.
 *
 * Once this has run, an owner can narrow any of those accounts from
 * Staff & users - which is the point. The migration is not a judgement that
 * everyone should be an owner; it is a refusal to guess that they should not.
 *
 * Add --drop-demo-logins to also delete the two accounts the old seed script
 * created for those roles. Their passwords were printed in the README, so
 * promoting them would leave two well-known logins holding every permission in
 * the shop. Deleting them costs nothing: a bill and a GRN store the name of
 * whoever entered them on the document itself, never as a lookup, so the
 * register still reads correctly afterwards.
 */

import "./load-env";
import mongoose from "mongoose";

import { connectDB } from "../lib/db";
import { ROLE_SCHEME_VERSION } from "../lib/roles";

const APPLY = process.argv.includes("--apply");
const DROP_DEMO = process.argv.includes("--drop-demo-logins");

/** The logins the old seed created for the roles that no longer exist. */
const DEMO_LOGINS = ["pharmacist@mantrapharma.local", "cashier@mantrapharma.local"];

/**
 * Read through the driver rather than the model.
 *
 * The rows being fixed here are, by definition, ones whose stored role does
 * not mean what the model would now read it as, so going through Mongoose -
 * and its casting, defaults and hooks - would be reading them through exactly
 * the lens this script exists to correct.
 */
function users() {
  return mongoose.connection.collection("users");
}

async function promoteStaleRoles(): Promise<void> {
  // `roleVersion` absent is what makes a row scheme 1. A pharmacist or cashier
  // written since - by the staff screen, at roleVersion 2 - means exactly what
  // it says and must be left alone; promoting those to admin would hand every
  // permission in the shop to someone an owner had deliberately narrowed.
  const filter = {
    role: { $in: ["pharmacist", "cashier"] },
    roleVersion: { $exists: false },
  };
  const stale = await users()
    .find(filter, { projection: { email: 1, role: 1 } })
    .toArray();

  if (stale.length === 0) {
    console.log("  no account is left on the old role scheme.");
    return;
  }

  for (const user of stale) {
    console.log(`  ${String(user.role).padEnd(11)} ${String(user.email)} -> admin`);
  }

  if (!APPLY) {
    console.log(`  ${stale.length} account(s) would be promoted.`);
    return;
  }

  const result = await users().updateMany(filter, {
    $set: { role: "admin", roleVersion: ROLE_SCHEME_VERSION },
  });
  console.log(`  promoted ${result.modifiedCount} account(s)`);
}

async function dropDemoLogins(): Promise<void> {
  const filter = { email: { $in: DEMO_LOGINS } };
  const found = await users().find(filter, { projection: { email: 1 } }).toArray();

  if (found.length === 0) {
    console.log("  no demo logins left to remove.");
    return;
  }

  for (const user of found) console.log(`  ${String(user.email)} -> deleted`);

  if (!APPLY) {
    console.log(`  ${found.length} demo login(s) would be deleted.`);
    return;
  }

  const result = await users().deleteMany(filter);
  console.log(`  removed ${result.deletedCount} demo login(s)`);
}

async function main() {
  await connectDB();
  console.log(APPLY ? "Applying role migration…" : "Dry run - nothing will be written.");
  console.log("");

  await promoteStaleRoles();

  if (DROP_DEMO) {
    console.log("");
    await dropDemoLogins();
  }

  // A session cookie signed under scheme 1 keeps working - it carries no `rv`
  // claim, so lib/roles.ts reads its role under the old meaning - and a shift
  // in progress is not interrupted by this migration.
  //
  // Counted with the same `roleVersion` clause as the update, so a cashier an
  // owner deliberately created since is not reported as leftover work.
  const remaining = await users().countDocuments({
    role: { $in: ["pharmacist", "cashier"] },
    roleVersion: { $exists: false },
  });
  console.log("");
  if (APPLY) {
    console.log(
      remaining === 0
        ? "No account is left on the old role scheme."
        : `${remaining} account(s) still on the old scheme?`,
    );
  } else {
    console.log("Re-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Migration failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
