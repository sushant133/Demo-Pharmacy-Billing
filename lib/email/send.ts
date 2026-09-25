import nodemailer, { type Transporter } from "nodemailer";
import { config } from "@/lib/config";
import { googleMailIsConfigured, sendViaGmail } from "@/lib/email/google";
import {
  addressOf,
  domainOf,
  messageIdFor,
  transactionalHeaders,
} from "@/lib/email/headers";
import {
  EMAIL_LOGO_CID,
  EMAIL_LOGO_FILENAME,
  emailLogoPng,
} from "@/lib/email/logo";
import {
  renderEmail,
  renderEmailText,
  type EmailContent,
} from "@/lib/email/layout";

/**
 * Outbound email.
 *
 * Two rules hold this file together.
 *
 * The first: **sending must never be the reason something else fails.**
 * Opening a pharmacy account writes a tenant, a settings record, an outlet
 * and an owner login. If the mail relay is down, all of that still has to
 * stand - the credentials can be read off the screen and re-sent later,
 * whereas a half-created pharmacy is a support call and a manual cleanup. So
 * `sendEmail` resolves with an outcome rather than throwing, and every caller
 * treats a failure as something to report, not something to unwind. Same
 * discipline as `recordPlatformEvent`.
 *
 * The second: **an unconfigured deployment is loud, not silent.** With no
 * transport at all the message is written to the server log in full,
 * including any link it carries. That is what a developer wants locally, and
 * it means a production box that forgot to configure mail shows up as
 * readable mail in the log rather than as nothing happening.
 *
 * Two transports, tried in that order of specificity: a Google account via
 * the Gmail API (lib/email/google.ts), then any SMTP relay.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  content: EmailContent;
}

export type EmailOutcome =
  | { sent: true; logged: false }
  /** No transport configured; written to the server log instead. */
  | { sent: false; logged: true }
  | { sent: false; logged: false; error: string };

/**
 * How this deployment sends, if it can.
 *
 * Google first: a refresh token is the more specific configuration, and a box
 * that has both almost certainly meant the Google one. SMTP is the general
 * fallback for anyone not on Google at all.
 */
export type EmailTransport = "google" | "smtp" | "none";

export function emailTransport(): EmailTransport {
  if (googleMailIsConfigured()) return "google";
  if (config.mail.host) return "smtp";
  return "none";
}

/** True when a real relay is configured and mail will actually go out. */
export function emailIsConfigured(): boolean {
  return emailTransport() !== "none";
}

/*
  One transporter for the process, built on first use.

  Nodemailer pools connections, and rebuilding it per message would open a
  fresh TCP+TLS handshake for every mail - which on a relay that rate-limits
  connections is the thing that starts getting refused.
*/
let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  const { dkim } = config.mail;
  cached = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user
      ? { user: config.mail.user, pass: config.mail.password }
      : undefined,
    pool: true,
    maxConnections: 3,
    // Signed here only when configured; most relays sign for a verified
    // domain themselves. See config.mail.dkim.
    ...(dkim.domain && dkim.selector && dkim.privateKey
      ? {
          dkim: {
            domainName: dkim.domain,
            keySelector: dkim.selector,
            privateKey: dkim.privateKey,
          },
        }
      : {}),
  });
  return cached;
}

/**
 * Warn, once per process, when the From domain cannot pass DMARC.
 *
 * Mail sent through a Google account is DKIM-signed for that account's
 * domain. A From on some other domain - MAIL_FROM=no-reply@mantramed.app
 * sent through someone@gmail.com - is unaligned, fails DMARC, and is exactly
 * the message Gmail files as spam. Not fatal: a Workspace alias with its own
 * signing can be legitimate, so this says so and carries on.
 */
let warnedAlignment = false;

function warnOnMisalignedFrom(transport: EmailTransport): void {
  if (warnedAlignment) return;
  warnedAlignment = true;
  const fromDomain = domainOf(config.mail.from);
  if (transport === "google" && config.googleMail.sender) {
    const senderDomain = domainOf(config.googleMail.sender);
    if (fromDomain && senderDomain && fromDomain !== senderDomain) {
      console.warn(
        `[email] MAIL_FROM (${addressOf(config.mail.from)}) is not on the Google account's domain (${senderDomain}). ` +
          "Unless that domain is set up to DKIM-sign this mail, it will fail DMARC and land in spam. " +
          "Send from the account's own domain, or run `npx tsx scripts/check-email-dns.ts`.",
      );
    }
  }
  if (transport === "smtp" && config.mail.dkim.domain && fromDomain && config.mail.dkim.domain.toLowerCase() !== fromDomain) {
    console.warn(
      `[email] DKIM_DOMAIN (${config.mail.dkim.domain}) does not match the MAIL_FROM domain (${fromDomain}); the signature will not align for DMARC.`,
    );
  }
}

/**
 * Send one message. Never throws.
 *
 * The returned outcome is for the caller to report - "the account is open but
 * we could not email the credentials" is a useful thing to put on screen, and
 * it is the difference between the superadmin reading the password out over
 * the phone and assuming it arrived.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailOutcome> {
  const html = renderEmail(message.content);
  const text = renderEmailText(message.content);
  const transport = emailTransport();

  if (transport === "none") {
    console.info(
      [
        "",
        "─".repeat(72),
        "[email] no mail transport configured - message not sent. Full text below.",
        "        set GOOGLE_MAIL_REFRESH_TOKEN (see scripts/google-mail-token.ts) or SMTP_HOST",
        `        to:      ${message.to}`,
        `        subject: ${message.subject}`,
        "─".repeat(72),
        text,
        "─".repeat(72),
        "",
      ].join("\n"),
    );
    return { sent: false, logged: true };
  }

  warnOnMisalignedFrom(transport);

  // The header logo travels inside the message; see lib/email/logo.ts.
  const logo = {
    cid: EMAIL_LOGO_CID,
    filename: EMAIL_LOGO_FILENAME,
    contentType: "image/png",
    content: emailLogoPng(),
  };

  try {
    if (transport === "google") {
      await sendViaGmail({
        to: message.to,
        subject: message.subject,
        text,
        html,
        inline: [logo],
      });
    } else {
      await transporter().sendMail({
        from: config.mail.from,
        to: message.to,
        subject: message.subject,
        text,
        html,
        messageId: messageIdFor(config.mail.from),
        headers: transactionalHeaders(),
        attachments: [{ ...logo, contentDisposition: "inline" }],
        ...(config.mail.replyTo ? { replyTo: config.mail.replyTo } : {}),
      });
    }
    return { sent: true, logged: false };
  } catch (error) {
    // Logged rather than rethrown: see the file note. The caller decides what
    // to tell the person, and the detail belongs in the server log.
    console.error(`[email] send failed via ${transport}`, {
      to: message.to,
      subject: message.subject,
      error,
    });
    return {
      sent: false,
      logged: false,
      error: error instanceof Error ? error.message : "Unknown mail error.",
    };
  }
}
