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

/**
 * The public origin that goes into emailed links (sign in, password reset).
 *
 * In order:
 *  1. `APP_URL`, when set - except a localhost value on Vercel, which is
 *     always a local `.env` copied across by mistake and would send every
 *     owner a link to their own machine.
 *  2. On Vercel, the address Vercel itself reports: the production domain
 *     (the custom domain if there is one, e.g. mantramed.tech) for a
 *     production deploy, the deployment's own URL for a preview.
 *  3. http://localhost:3000, for local development.
 *
 * Deliberately never the request's Host header: a reset email built from
 * that can be pointed at an attacker's domain by whoever asks for it.
 */
export function resolveAppUrl(env: Record<string, string | undefined>): string {
  const onVercel = Boolean(env.VERCEL);
  const explicit = unquoteEnv(env.APP_URL);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(explicit);

  let url = "";
  if (explicit && !(onVercel && isLocal)) {
    url = explicit;
  } else if (onVercel) {
    const host =
      env.VERCEL_ENV === "production"
        ? unquoteEnv(env.VERCEL_PROJECT_PRODUCTION_URL) || unquoteEnv(env.VERCEL_URL)
        : unquoteEnv(env.VERCEL_URL);
    if (host) url = `https://${host}`;
  }
  return (url || "http://localhost:3000").replace(/\/+$/, "");
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
  /**
   * Outbound email.
   *
   * Plain SMTP, so it works with whatever the deployment already has - a
   * Google Workspace account, a provider's relay, a mailtrap in staging.
   * With no host configured the app does not fail: `lib/email/send.ts`
   * writes the message to the server log instead, which is what a developer
   * wants locally and what makes a missing configuration loud rather than
   * silent.
   *
   * `appUrl` is the origin that goes into a password-reset link. It has to
   * be the address the user's browser can actually reach, which the server
   * cannot infer reliably from behind a proxy.
   */
  /**
   * Sending through a Google account.
   *
   * Preferred over SMTP when a refresh token is present - see
   * lib/email/google.ts for why the Gmail API rather than smtp.gmail.com.
   * `scripts/google-mail-token.ts` is what mints the refresh token.
   */
  googleMail: {
    clientId: unquoteEnv(process.env.GOOGLE_CLIENT_ID),
    clientSecret: unquoteEnv(process.env.GOOGLE_CLIENT_SECRET),
    refreshToken: unquoteEnv(process.env.GOOGLE_MAIL_REFRESH_TOKEN),
    /** The Gmail address that granted consent. Recorded for error messages. */
    sender: unquoteEnv(process.env.GOOGLE_MAIL_SENDER),
  },
  mail: {
    host: unquoteEnv(process.env.SMTP_HOST),
    port: num(process.env.SMTP_PORT, 587),
    // 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
    secure: (process.env.SMTP_SECURE ?? "").toLowerCase() === "true"
      || num(process.env.SMTP_PORT, 587) === 465,
    user: unquoteEnv(process.env.SMTP_USER),
    password: unquoteEnv(process.env.SMTP_PASSWORD),
    from: unquoteEnv(process.env.MAIL_FROM) || "MantraMed <no-reply@mantramed.app>",
    replyTo: unquoteEnv(process.env.MAIL_REPLY_TO),
  },
  appUrl: resolveAppUrl(process.env),
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
