/**
 * Central place for environment-derived settings.
 * Everything has a sane default so the app boots without a full .env,
 * except the secrets which fail loudly in production.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Strip wrapping quotes some editors / dotenv leave on values. */
export function unquoteEnv(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Database name from a Mongo URI path, if present.
 * Atlas host-list URIs often omit it (`...27017/?ssl=true`), which would
 * otherwise land Mongoose in the `test` database.
 */
export function dbNameFromMongoUri(uri: string): string | undefined {
  const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//i, "");
  const at = withoutProtocol.lastIndexOf("@");
  const rest = at >= 0 ? withoutProtocol.slice(at + 1) : withoutProtocol;
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const afterSlash = rest.slice(slash + 1);
  const q = afterSlash.indexOf("?");
  const name = (q >= 0 ? afterSlash.slice(0, q) : afterSlash)
    .replace(/\/+$/, "")
    .trim();
  return name || undefined;
}

const isProd = process.env.NODE_ENV === "production";

const mongoUri =
  unquoteEnv(process.env.MONGODB_URI) ||
  "mongodb://127.0.0.1:27017/mantrapharma";
const mongoDb =
  unquoteEnv(process.env.MONGODB_DB) ||
  dbNameFromMongoUri(mongoUri) ||
  "mantrapharma";

export const config = {
  isProd,
  mongoUri,
  mongoDb,
  authSecret: process.env.AUTH_SECRET ?? "",
  sessionTtlSeconds: num(process.env.AUTH_SESSION_TTL, 60 * 60 * 12),
  vatRate: num(process.env.VAT_RATE, 0.13),
  lowStockThreshold: num(process.env.LOW_STOCK_THRESHOLD, 20),
  expiryAlertDays: num(process.env.EXPIRY_ALERT_DAYS, 90),
  timezone: process.env.BUSINESS_TIMEZONE ?? "Asia/Kathmandu",
  business: {
    name: process.env.BUSINESS_NAME ?? "Mantra Pharmacy",
    address: process.env.BUSINESS_ADDRESS ?? "",
    phone: process.env.BUSINESS_PHONE ?? "",
    pan: process.env.BUSINESS_PAN ?? "",
  },
} as const;

/** Session cookie name. Kept here so middleware and route handlers agree. */
export const SESSION_COOKIE = "mp_session";

/**
 * Where a superadmin's own session waits while they are signed in as a shop
 * owner. Holding it in a second cookie is what makes "return to platform" a
 * click rather than a fresh sign-in, and keeps the whole thing stateless.
 */
export const IMPERSONATION_COOKIE = "mp_platform_session";

/**
 * How long an impersonated session lasts, however long a normal one does.
 *
 * Support work is minutes; a session that can act inside somebody else's till
 * should not outlive the call that justified it.
 */
export const IMPERSONATION_TTL_SECONDS = 30 * 60;

export function requireAuthSecret(): string {
  const secret = config.authSecret;
  if (secret.length >= 32) return secret;
  if (isProd) {
    throw new Error(
      "AUTH_SECRET is missing or shorter than 32 characters. Refusing to sign sessions in production.",
    );
  }
  // Dev-only fallback so a fresh clone runs before .env.local exists.
  return "dev-only-insecure-secret-do-not-use-in-production!!";
}
