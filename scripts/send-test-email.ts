/**
 * Prove the mail configuration works, without opening a pharmacy to do it.
 *
 *   npx tsx scripts/send-test-email.ts you@example.com
 *
 * Sends the real welcome template, through the real transport, with made-up
 * credentials - so what arrives is exactly what a pharmacy owner sees, and
 * the password in it is not one that opens anything.
 */

import "./load-env";
import { emailTransport } from "../lib/email/send";
import { sendPharmacyWelcomeEmail } from "../lib/email/messages";
import { config } from "../lib/config";

async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to || !to.includes("@")) {
    console.error("\nUsage: npx tsx scripts/send-test-email.ts you@example.com\n");
    process.exit(1);
  }

  const transport = emailTransport();
  console.log(`transport : ${transport}`);
  console.log(`from      : ${config.mail.from}`);
  if (transport === "google") {
    console.log(`authorised: ${config.googleMail.sender || "(GOOGLE_MAIL_SENDER not set)"}`);
  }
  console.log(`to        : ${to}\n`);

  if (transport === "none") {
    console.log(
      "No transport is configured, so the message below is only being logged.\n" +
        "Set GOOGLE_MAIL_REFRESH_TOKEN (scripts/google-mail-token.ts) or SMTP_HOST.\n",
    );
  }

  const outcome = await sendPharmacyWelcomeEmail({
    to,
    ownerName: "Test Owner",
    pharmacyName: "Test Pharmacy",
    email: to,
    // Obviously fake, so a test mail left in an inbox is not a live credential.
    password: "not-a-real-password",
  });

  if (outcome.sent) {
    console.log("\n✓ Sent. Check the inbox, and the spam folder if it is not there.");
  } else if (outcome.logged) {
    console.log("\n… Logged above rather than sent, because no transport is configured.");
  } else {
    console.error(`\n✗ Not sent: ${outcome.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
