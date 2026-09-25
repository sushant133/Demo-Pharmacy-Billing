import { EMAIL_LOGO_PNG_BASE64 } from "@/lib/email/logo-data";

/**
 * The header logo, carried inside the message itself.
 *
 * It used to be an `<img>` pointing at `${APP_URL}/icon-192.png`, which fails
 * in exactly the cases that matter: APP_URL left at localhost, a preview
 * deployment behind Vercel's login wall, or Gmail's image proxy simply unable
 * to reach the host. Gmail also refuses `data:` URIs outright. A CID inline
 * part is what every major client - Gmail, Outlook, Apple Mail - renders
 * without asking, and at 4KB it costs every recipient almost nothing.
 *
 * The bytes come from a generated module rather than `public/`, because a
 * serverless function does not reliably have `public/` on its filesystem.
 */

/** Referenced from the HTML as `cid:<this>`. */
export const EMAIL_LOGO_CID = "logo@mantramed";

export const EMAIL_LOGO_FILENAME = "mantramed-logo.png";

let bytes: Buffer | null = null;

export function emailLogoPng(): Buffer {
  if (!bytes) bytes = Buffer.from(EMAIL_LOGO_PNG_BASE64, "base64");
  return bytes;
}
