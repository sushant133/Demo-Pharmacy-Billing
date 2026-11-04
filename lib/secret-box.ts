import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config, requireAuthSecret } from "@/lib/config";

/**
 * Symmetric encryption for the few secrets the app has to keep and later use
 * as-is - today, a pharmacy's CBMS password. Hashing will not do for those:
 * the value has to be sent to IRD, not compared.
 *
 * AES-256-GCM, key derived from CREDENTIALS_SECRET (or AUTH_SECRET). Stored as
 * "v1:<iv>:<tag>:<ciphertext>", base64. A database dump alone does not reveal
 * the password; it also needs the server's environment.
 */

function key(): Buffer {
  const secret =
    config.credentialsSecret.length >= 32 ? config.credentialsSecret : requireAuthSecret();
  return createHash("sha256").update(`mantrapharma:secret-box:${secret}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/** The plain value, or null if it was sealed under another key or is damaged. */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
