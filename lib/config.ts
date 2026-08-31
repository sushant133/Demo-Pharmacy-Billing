/**
 * Central place for environment-derived settings.
 * Everything has a sane default so the app boots without a full .env,
 * except the secrets which fail loudly in production.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  isProd,
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/mantrapharma",
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
