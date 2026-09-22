/**
 * Mint the Gmail refresh token MantraMed sends with.
 *
 *   npx tsx scripts/google-mail-token.ts
 *
 * Run once, by hand. It walks through Google's consent screen and prints the
 * two lines to paste into `.env.local`. Nothing in the running app performs
 * this exchange - a refresh token is issued to a human who clicked "Allow",
 * and that click cannot be automated.
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET already set.
 *
 * The redirect goes to http://localhost:3000, which is registered on the
 * client and is also where the dev server lives. Nothing is listening for the
 * callback on purpose: Google redirects the browser there, the page may well
 * 404, and the `code` is sitting in the address bar to be pasted back. That
 * is simpler and less fragile than starting a second server on a port the
 * dev server may already hold.
 */

import "./load-env";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const REDIRECT = "http://localhost:3000";

function need(name: string): string {
  const value = (process.env[name] ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) {
    console.error(
      `\n${name} is not set. Put the client id and secret in .env.local first:\n` +
        "  GOOGLE_CLIENT_ID=...apps.googleusercontent.com\n" +
        "  GOOGLE_CLIENT_SECRET=GOCSPX-...\n",
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const clientId = need("GOOGLE_CLIENT_ID");
  const clientSecret = need("GOOGLE_CLIENT_SECRET");

  const consent =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPE,
      // Without both of these Google returns an access token only, and the
      // whole point of this script is the refresh token. `prompt=consent`
      // forces a fresh one even if the account has approved before.
      access_type: "offline",
      prompt: "consent",
    }).toString();

  console.log(
    [
      "",
      "─".repeat(78),
      " MantraMed - authorise a Google account to send mail",
      "─".repeat(78),
      "",
      " 1. Open this in a browser, signed in as the account that should send:",
      "",
      `    ${consent}`,
      "",
      " 2. Approve the request. Google will send the browser to",
      `    ${REDIRECT}/?code=...  - the page itself does not matter and may`,
      "    show an error. What matters is the address bar.",
      "",
      " 3. Copy the value of `code=` from that address and paste it below.",
      "    (Everything between `code=` and the next `&`.)",
      "",
      "─".repeat(78),
      "",
    ].join("\n"),
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const pasted = (await rl.question("code: ")).trim();
  rl.close();

  if (!pasted) {
    console.error("\nNothing pasted. Nothing done.");
    process.exit(1);
  }

  // A pasted URL is the likelier mistake than a bare code, so accept both.
  let code = pasted;
  if (pasted.includes("code=")) {
    code = new URLSearchParams(pasted.split("?")[1] ?? pasted).get("code") ?? pasted;
  }
  code = decodeURIComponent(code);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.refresh_token) {
    console.error(
      `\nGoogle refused the exchange: ${body.error ?? response.status} - ${body.error_description ?? "no detail"}`,
    );
    if (body.access_token && !body.refresh_token) {
      console.error(
        "An access token came back but no refresh token. That happens when the\n" +
          "account has approved this client before - the consent URL above sets\n" +
          "prompt=consent to avoid it, so try again with a freshly copied code.",
      );
    }
    if (body.error === "invalid_grant") {
      console.error(
        "A code can only be exchanged once, and expires within minutes. Re-run\n" +
          "the script and paste a fresh one.",
      );
    }
    process.exit(1);
  }

  // Ask Gmail who just authorised, so the From address can be checked against
  // it rather than guessed. Gmail will only send as this account or an alias.
  let sender = "";
  try {
    const profile = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${body.access_token}` } },
    );
    if (profile.ok) {
      sender = ((await profile.json()) as { emailAddress?: string }).emailAddress ?? "";
    }
  } catch {
    // Not worth failing for; the token is the thing that matters.
  }

  console.log(
    [
      "",
      "─".repeat(78),
      " Done. Add these to .env.local:",
      "─".repeat(78),
      "",
      `GOOGLE_MAIL_REFRESH_TOKEN=${body.refresh_token}`,
      ...(sender
        ? [
            `GOOGLE_MAIL_SENDER=${sender}`,
            `MAIL_FROM=MantraMed <${sender}>`,
          ]
        : [
            "GOOGLE_MAIL_SENDER=<the address you just authorised>",
            "MAIL_FROM=MantraMed <the address you just authorised>",
          ]),
      "",
      "─".repeat(78),
      "",
      " Then restart the dev server and check it with:",
      "   npx tsx scripts/send-test-email.ts you@example.com",
      "",
      ...(sender
        ? [
            ` Gmail will only send as ${sender} or one of its verified aliases,`,
            " so MAIL_FROM has to be one of those.",
            "",
          ]
        : []),
      " Note: while the OAuth consent screen is in Testing, Google expires",
      " refresh tokens after 7 days. Publish the app to stop that.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
