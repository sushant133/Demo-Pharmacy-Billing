/**
 * Check the DNS records that decide whether MantraMed mail reaches the inbox.
 *
 *   npx tsx scripts/check-email-dns.ts                 # domain from MAIL_FROM
 *   npx tsx scripts/check-email-dns.ts mantramed.tech  # or name one
 *   DKIM_SELECTOR=google npx tsx scripts/check-email-dns.ts
 *
 * SPF, DKIM and DMARC are DNS records on the sending domain, not code - no
 * change to this app can publish them. What this does is read them back and
 * say, in plain terms, what is missing and what to add. Gmail and Yahoo have
 * required all three of bulk senders since 2024 and score everyone else on
 * them; a domain missing any of them is the usual reason mail goes to spam.
 *
 * Exits non-zero when something required is missing, so it can gate a deploy.
 */

import { promises as dns } from "node:dns";
import { config } from "@/lib/config";
import { domainOf } from "@/lib/email/headers";
import { emailTransport } from "@/lib/email/send";

/** Selectors the common providers publish, tried when none is configured. */
const COMMON_SELECTORS = [
  "google", // Google Workspace
  "selector1", "selector2", // Microsoft 365
  "s1", "s2", // SendGrid
  "k1", // Mailchimp / Mandrill
  "resend",
  "pm", // Postmark
  "mail", "default", "dkim",
];

/** Domains whose SPF/DKIM/DMARC are the provider's, not the deployment's. */
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com"]);

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string, fix: string) => {
  failures++;
  console.log(`  ✗ ${msg}\n      fix: ${fix}`);
};
const warn = (msg: string) => console.log(`  ! ${msg}`);

async function checkSpf(domain: string, transport: string): Promise<void> {
  console.log("\nSPF");
  const records = (await txt(domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  if (records.length === 0) {
    const include =
      transport === "google" || /gmail\.com$/i.test(config.mail.host)
        ? "include:_spf.google.com"
        : "include:<your relay's SPF domain>";
    fail(`no SPF record on ${domain}`, `add TXT @  "v=spf1 ${include} ~all"`);
    return;
  }
  if (records.length > 1) {
    fail(`${records.length} SPF records on ${domain}`, "merge them into one; two SPF records is a permanent error");
    return;
  }
  const spf = records[0]!;
  ok(spf);
  if (transport === "google" && !spf.includes("_spf.google.com")) {
    warn("sending through Google, but the record does not include:_spf.google.com");
  }
  if (/\+all\b/.test(spf)) warn("+all lets anyone send as this domain - use ~all or -all");
}

async function checkDkim(domain: string): Promise<void> {
  console.log("\nDKIM");
  const configured = process.env.DKIM_SELECTOR || config.mail.dkim.selector;
  const selectors = configured ? [configured] : COMMON_SELECTORS;
  const found: string[] = [];
  for (const selector of selectors) {
    const records = await txt(`${selector}._domainkey.${domain}`);
    if (records.some((r) => /(^|;)\s*(v=DKIM1|p=)/i.test(r))) found.push(selector);
  }
  if (found.length) {
    ok(`public key published for selector(s): ${found.join(", ")}`);
    return;
  }
  fail(
    configured
      ? `no DKIM key at ${configured}._domainkey.${domain}`
      : `no DKIM key found under the common selectors (${COMMON_SELECTORS.join(", ")})`,
    "Google Workspace: Admin console > Apps > Gmail > Authenticate email > Generate new record, " +
      "publish the TXT at google._domainkey, then click Start authentication. " +
      "Other relays: verify the domain in their dashboard. Self-signed SMTP: set DKIM_DOMAIN/DKIM_SELECTOR/DKIM_PRIVATE_KEY " +
      "and publish the matching public key. (If you use another selector, pass DKIM_SELECTOR to check it.)",
  );
}

async function checkDmarc(domain: string): Promise<void> {
  console.log("\nDMARC");
  const records = (await txt(`_dmarc.${domain}`)).filter((r) => r.toLowerCase().startsWith("v=dmarc1"));
  if (records.length === 0) {
    fail(
      `no DMARC record at _dmarc.${domain}`,
      `add TXT _dmarc  "v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r"  ` +
        "(start at p=none, move to quarantine once reports show SPF/DKIM passing)",
    );
    return;
  }
  ok(records[0]!);
}

async function main(): Promise<void> {
  const transport = emailTransport();
  const domain = (process.argv[2] || domainOf(config.mail.from)).toLowerCase();

  console.log(`From:      ${config.mail.from}`);
  console.log(`Transport: ${transport}`);
  console.log(`Domain:    ${domain || "(none)"}`);

  if (!domain) {
    console.log("\nMAIL_FROM has no domain - nothing to check.");
    process.exit(1);
  }

  if (FREEMAIL.has(domain)) {
    console.log(
      `\n${domain} is a consumer mailbox: its SPF, DKIM and DMARC belong to the provider and already pass ` +
        "when you send through that account. Consumer accounts are still weighted as low-reputation senders " +
        "for transactional mail - for reliable inbox delivery, send from a domain you own.",
    );
    return;
  }

  if (transport === "google" && config.googleMail.sender) {
    const senderDomain = domainOf(config.googleMail.sender);
    if (senderDomain !== domain) {
      console.log("\nAlignment");
      fail(
        `MAIL_FROM is on ${domain} but mail is sent through ${config.googleMail.sender}`,
        FREEMAIL.has(senderDomain)
          ? `mail from ${senderDomain} is DKIM-signed as ${senderDomain}, so a ${domain} From fails DMARC. ` +
              `Send from a Google Workspace account on ${domain}, or remove MAIL_FROM to send as ${config.googleMail.sender}.`
          : `make ${domain} a Workspace domain with DKIM enabled, or set MAIL_FROM to an address on ${senderDomain}.`,
      );
    }
  }

  await checkSpf(domain, transport);
  await checkDkim(domain);
  await checkDmarc(domain);

  console.log(
    failures
      ? `\n${failures} problem(s). Fix the records above; DNS changes can take up to an hour to be seen.`
      : "\nAll present. Confirm with a real send: in Gmail, open the message > Show original - SPF, DKIM and DMARC should all read PASS.",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
