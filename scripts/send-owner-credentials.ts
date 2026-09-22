/**
 * Issue a pharmacy owner a new password and email it to them.
 *
 *   npx tsx scripts/send-owner-credentials.ts owner@example.com
 *   npx tsx scripts/send-owner-credentials.ts owner@example.com --password 'Chosen@123'
 *   npx tsx scripts/send-owner-credentials.ts owner@example.com --dry-run
 *
 * The recovery path for a welcome email that never arrived, from a terminal
 * rather than the superadmin screen - useful when the account was opened
 * before mail was configured, or when a relay was down at the time.
 *
 * It **sets a new password**. It cannot do otherwise: the original is bcrypt
 * hashed and cannot be read back, so "re-send the credentials" is not a thing
 * that exists. Whatever password was set before this runs stops working.
 *
 * Does the same work as POST /api/pharmacies/:id/owner-password, including
 * writing the platform event, so a reset done here is as accountable as one
 * done through the UI.
 */

import "./load-env";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import { connectDB } from "../lib/db";
import { Pharmacy } from "../models/Pharmacy";
import { User } from "../models/User";
import { resetOwnerPassword } from "../lib/pharmacies";
import { recordPlatformEvent } from "../lib/platform-events";
import { sendOwnerCredentialsEmail } from "../lib/email/messages";
import { emailTransport } from "../lib/email/send";
import { config } from "../lib/config";
import type { SessionUser } from "../lib/session";

/**
 * A password that is strong, and that survives being read down a phone line.
 *
 * No l/1/I or O/0, because the whole point of this script is an owner who
 * could not be reached the easy way - and the fallback is someone reading it
 * out loud.
 */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(14);
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  // A symbol and a digit are guaranteed, so it clears any policy it meets.
  return `${body.slice(0, 6)}-${body.slice(6, 12)}#${bytes[13]! % 10}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const chosen = args.includes("--password")
    ? args[args.indexOf("--password") + 1]
    : undefined;

  if (!target) {
    console.error(
      "\nUsage: npx tsx scripts/send-owner-credentials.ts <owner-email|pharmacy-slug> [--password '...'] [--dry-run]\n",
    );
    process.exit(1);
  }

  await connectDB();

  const needle = target.trim().toLowerCase();
  const pharmacy = await Pharmacy.findOne({
    $or: [{ ownerEmail: needle }, { slug: needle }],
  })
    .select("_id name slug ownerEmail ownerName status")
    .lean();

  if (!pharmacy) {
    console.error(`\nNo pharmacy found with owner email or slug "${target}".`);
    const all = await Pharmacy.find().select("name slug ownerEmail").lean();
    console.error("\nKnown pharmacies:");
    for (const p of all) console.error(`  ${p.slug.padEnd(24)} ${p.ownerEmail}`);
    console.error("");
    await mongoose.disconnect();
    process.exit(1);
  }

  const transport = emailTransport();
  console.log(`pharmacy : ${pharmacy.name} (${pharmacy.slug})`);
  console.log(`owner    : ${pharmacy.ownerName} <${pharmacy.ownerEmail}>`);
  console.log(`transport: ${transport}`);
  console.log(`from     : ${config.mail.from}`);

  if (transport === "none") {
    console.error(
      "\nThere is no mail transport configured, so nothing can be sent.\n" +
        "Run `npx tsx scripts/google-mail-token.ts` first, put the two lines it\n" +
        "prints into .env.local, then run this again.\n\n" +
        "Nothing has been changed - the current password still works.\n",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const password = chosen ?? generatePassword();

  if (dryRun) {
    console.log(
      `\n--dry-run: would set a new password and email it to ${pharmacy.ownerEmail}.\nNothing changed.\n`,
    );
    await mongoose.disconnect();
    return;
  }

  console.log("\nsetting the new password…");
  await resetOwnerPassword(String(pharmacy._id), password);

  console.log("sending…");
  const delivery = await sendOwnerCredentialsEmail({
    to: pharmacy.ownerEmail,
    ownerName: pharmacy.ownerName,
    pharmacyName: pharmacy.name,
    email: pharmacy.ownerEmail,
    password,
  });

  // Same accountability as the UI route: who did it, to which login, and
  // whether it landed. The password itself is never recorded.
  const actor = await User.findOne({ role: "superadmin" }).select("_id name").lean();
  await recordPlatformEvent(
    {
      id: actor ? String(actor._id) : "",
      name: actor ? `${actor.name} (command line)` : "command line",
    } as Pick<SessionUser, "id" | "name">,
    "owner.password-reset",
    {
      pharmacyId: String(pharmacy._id),
      pharmacyName: pharmacy.name,
      summary: `Reset the owner password for ${pharmacy.ownerEmail}.`,
      detail: delivery.sent
        ? `New credentials emailed to ${pharmacy.ownerEmail} from the command line.`
        : `Password was changed but not emailed: ${delivery.logged ? "no transport" : delivery.error}`,
    },
  );

  if (delivery.sent) {
    console.log(`\n✓ Sent to ${pharmacy.ownerEmail}. Check the inbox and the spam folder.`);
    console.log("  The password is not printed here - it is in the email.\n");
  } else {
    // The password is already changed, so it has to be shown or the account
    // is locked out. Printing it is the lesser harm.
    console.error(`\n✗ The password was changed but the email failed.`);
    console.error(`  ${delivery.logged ? "No transport configured." : delivery.error}`);
    console.error(`\n  Pass this on by hand: ${password}\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
