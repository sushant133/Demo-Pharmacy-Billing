import { config } from "@/lib/config";
import { messageIdFor, transactionalHeaders } from "@/lib/email/headers";

/**
 * Sending through a Google account, over the Gmail API.
 *
 * Two choices here are worth the paragraph.
 *
 * **The Gmail API rather than SMTP.** Nodemailer can do XOAUTH2 over
 * smtp.gmail.com, and it would have reused the transport already in this
 * folder - but it needs the `https://mail.google.com/` scope, which Google
 * classes as *restricted*: taking that to production means a third-party
 * security assessment. `gmail.send` is merely *sensitive*, grants exactly one
 * capability, and cannot read a mailbox even if these credentials leak.
 *
 * **Plain fetch rather than `googleapis`.** The official client is a very
 * large dependency for two HTTP calls - one to swap a refresh token for an
 * access token, one to post a message. Both are documented, stable and
 * short, so they are written out here.
 *
 * What this file never does is store a password. A refresh token is held in
 * the environment; access tokens live in memory for an hour and are minted on
 * demand.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** The single capability this integration asks for. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export function googleMailIsConfigured(): boolean {
  const { clientId, clientSecret, refreshToken } = config.googleMail;
  return Boolean(clientId && clientSecret && refreshToken);
}

/*
  One access token per process, reused until it is nearly spent.

  Google issues these with an hour's life. Minting a fresh one per message
  would be an extra round trip on every send and, on a busy day, enough token
  requests to get rate limited for no benefit.
*/
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Thrown for anything Google refuses. Callers turn it into an outcome. */
class GoogleMailError extends Error {}

async function accessToken(): Promise<string> {
  // 60s of slack, so a token cannot expire between the check and the send.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleMail.clientId,
      client_secret: config.googleMail.clientSecret,
      refresh_token: config.googleMail.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    /*
      `invalid_grant` is the one worth naming. It means the refresh token is
      no longer good - which on a consent screen still in "Testing" is what
      happens after seven days, and is otherwise what happens when the Google
      password changes or access is revoked. Without this hint the symptom is
      a bare 400 and a long afternoon.
    */
    const hint =
      body.error === "invalid_grant"
        ? " The refresh token is no longer valid - re-run `npx tsx scripts/google-mail-token.ts`. If the OAuth consent screen is still in Testing mode, Google expires these after 7 days; publishing the app stops that."
        : "";
    throw new GoogleMailError(
      `Google refused the refresh token (${body.error ?? response.status}: ${body.error_description ?? "no detail"}).${hint}`,
    );
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/**
 * Encode a header value that may contain non-ASCII.
 *
 * A subject naming a pharmacy can carry Devanagari, and an RFC 822 header is
 * ASCII only. RFC 2047 "encoded-word" is how that is carried; left raw, the
 * characters arrive as mojibake or the message is rejected outright.
 */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** An image carried inside the message and referenced as `cid:<cid>`. */
export interface InlineImage {
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Build the RFC 822 message.
 *
 * `multipart/alternative` with the plain-text part first: that order is the
 * specification's, and it is how a client knows the HTML is the richer
 * version of the same thing rather than a separate attachment.
 *
 * With inline images, the alternative part is wrapped in `multipart/related`
 * alongside them - the structure that tells a client the images belong to
 * the HTML, so Gmail draws the logo in place instead of listing it as an
 * attachment.
 *
 * Every part is base64 so that no line can exceed the 998-character limit
 * and nothing has to be quoted-printable-escaped by hand.
 */
export function buildMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  inline?: InlineImage[];
  date?: Date;
}): string {
  const token = () =>
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const altBoundary = `mm_alt_${token()}`;
  const b64 = (value: string | Buffer) =>
    (typeof value === "string" ? Buffer.from(value, "utf8") : value)
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n");

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(input.text),
    "",
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(input.html),
    "",
    `--${altBoundary}--`,
  ];

  const extra = Object.entries(transactionalHeaders()).map(
    ([name, value]) => `${name}: ${value}`,
  );

  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: ${messageIdFor(input.from)}`,
    ...extra,
    "MIME-Version: 1.0",
  ];

  if (!input.inline?.length) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      ...alternative,
      "",
    ].join("\r\n");
  }

  const relBoundary = `mm_rel_${token()}`;
  const images = input.inline.flatMap((image) => [
    `--${relBoundary}`,
    `Content-Type: ${image.contentType}; name="${image.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${image.cid}>`,
    `Content-Disposition: inline; filename="${image.filename}"`,
    "",
    b64(image.content),
    "",
  ]);

  return [
    ...headers,
    `Content-Type: multipart/related; boundary="${relBoundary}"; type="multipart/alternative"`,
    "",
    `--${relBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    ...alternative,
    "",
    ...images,
    `--${relBoundary}--`,
    "",
  ].join("\r\n");
}

/**
 * Post one message. Throws on refusal; `lib/email/send.ts` catches.
 *
 * The Gmail API takes the whole message base64url encoded, not as fields.
 */
export async function sendViaGmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  inline?: InlineImage[];
}): Promise<void> {
  const token = await accessToken();

  const raw = Buffer.from(
    buildMimeMessage({
      from: config.mail.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: config.mail.replyTo || undefined,
      inline: input.inline,
    }),
    "utf8",
  ).toString("base64url");

  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
    };
    /*
      A 403 here is almost always the From address. Gmail will only send as
      the account that granted consent, or an alias it owns - anything else
      is refused no matter how valid the token is.
    */
    const hint =
      response.status === 403
        ? ` Check MAIL_FROM is the Google account that granted access (${config.googleMail.sender || "GOOGLE_MAIL_SENDER is not set"}) or one of its verified aliases.`
        : "";
    throw new GoogleMailError(
      `Gmail refused the message (${response.status} ${detail.error?.status ?? ""}: ${detail.error?.message ?? "no detail"}).${hint}`,
    );
  }
}
