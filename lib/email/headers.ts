import { randomBytes } from "node:crypto";

/**
 * Headers that decide whether a message reads as transactional mail or as
 * something a filter should be suspicious of.
 *
 * None of this substitutes for SPF, DKIM and DMARC on the sending domain -
 * those live in DNS, and `npx tsx scripts/check-email-dns.ts` reports on
 * them. What code can do is not look like a bulk sender that forgot the
 * basics: a Message-ID on our own domain, a Date, and the markers that say
 * "machine-generated, do not auto-reply".
 */

/** The bare address out of `Name <addr@host>` or `addr@host`. */
export function addressOf(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return (angled?.[1] ?? from).trim();
}

/** The domain of a From value, lower-cased. Empty if there is none. */
export function domainOf(from: string): string {
  const address = addressOf(from);
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

/**
 * A Message-ID on the From domain.
 *
 * A missing one, or one on a domain unrelated to the sender, is a small but
 * consistent spam signal. The random part keeps every message distinct.
 */
export function messageIdFor(from: string): string {
  const domain = domainOf(from) || "mantramed.local";
  return `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;
}

/**
 * Headers every MantraMed message carries, besides From/To/Subject.
 *
 * - `Auto-Submitted` (RFC 3834) and `X-Auto-Response-Suppress` stop
 *   out-of-office replies bouncing back at a no-reply address.
 * - `X-Entity-Ref-ID` is unique per message so Gmail does not collapse two
 *   reset emails with the same subject into one thread, hiding the newer
 *   link under the older one.
 */
export function transactionalHeaders(): Record<string, string> {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "All",
    "X-Entity-Ref-ID": randomBytes(12).toString("hex"),
  };
}
