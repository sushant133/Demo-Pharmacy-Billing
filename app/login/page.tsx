import type { Metadata } from "next";
import { LoginForm } from "@/components/LoginForm";
import { adToBs, formatBs, nepaliFiscalYear } from "@/lib/bs-date";
import { config } from "@/lib/config";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { localParts } from "@/lib/dates";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign-in screen.
 *
 * Server component around one interactive island, so the shop's identity, the
 * date and the branding render on the server and only the credential form
 * ships JavaScript.
 *
 * Two audiences meet here. A stranger who found the URL should learn nothing
 * they could use. Staff opening the counter should be able to tell at a
 * glance, without signing in, that this is the right terminal for the right
 * shop on the right day - which is why the card carries the trading name, the
 * PAN, both calendars and the fiscal year rather than a headline alone.
 * Pharmacy records are regulated and auditable, and the door to them should
 * look like it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  // Only accept same-origin relative paths, so ?next= cannot be used as an
  // open redirect to another site.
  const safeNext =
    params.next && params.next.startsWith("/") && !params.next.startsWith("//")
      ? params.next
      : null;
  const next = safeNext ?? "/billing";

  // Both calendars, resolved in the shop's timezone rather than the server's.
  // A Nepali counter works in Bikram Sambat and files against the BS fiscal
  // year; showing Gregorian alone would make the date someone else's.
  const now = new Date();
  const local = localParts(now, config.timezone);
  const bs = adToBs(local.year, local.month, local.day);
  const adLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: config.timezone,
  }).format(now);

  const sessionHours = Math.max(1, Math.round(config.sessionTtlSeconds / 3600));

  // The shop names itself, from Settings. Falls back to the environment
  // defaults if Mongo is unreachable, so the door still opens.
  const shop = await getSettings();
  const shopAddress = [shop.address, shop.city].filter(Boolean).join(", ");

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] xl:grid-cols-2">
      <BrandPanel shop={shop} address={shopAddress} />

      {/* Counter panel */}
      <div className="flex flex-col justify-center bg-slate-100 px-4 py-10 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-[26rem]">
          <MobileBrand />

          <div className="login-card overflow-hidden">
            {/* Terminal strip: which shop this till belongs to. */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold tracking-[0.08em] text-slate-500 uppercase">
                  {shop.businessName}
                </p>
                {shopAddress ? (
                  <p className="truncate text-[11px] text-slate-400">{shopAddress}</p>
                ) : null}
              </div>
              <SecureBadge />
            </div>

            <div className="px-5 py-6 sm:px-7 sm:py-7">
              <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-slate-900">
                Sign in to the counter
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                {safeNext && safeNext !== "/billing" ? (
                  <>
                    Sign in to continue to{" "}
                    <span className="font-medium text-slate-700">{safeNext}</span>.
                  </>
                ) : (
                  "Enter your staff credentials to open billing."
                )}
              </p>

              <div className="mt-6">
                <LoginForm next={next} />
              </div>
            </div>

            {/* Date strip: both calendars, and the year bills are filed under. */}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-200 bg-slate-50 px-5 py-3 text-[11px] text-slate-500">
              <span className="tnum">
                {adLabel}
                <span className="mx-1.5 text-slate-300">&middot;</span>
                <span className="font-medium text-slate-600">{formatBs(bs)}</span>
              </span>
              <span className="tnum">FY {nepaliFiscalYear(bs)}</span>
            </div>
          </div>

          <p className="mt-5 text-center text-xs leading-relaxed text-slate-500">
            A session lasts {sessionHours} hours. Sign out before you leave the
            counter &mdash; every bill is recorded against the account that
            raised it.
          </p>

          {shop.pan ? (
            <p className="mt-2 text-center text-[11px] text-slate-400">
              PAN <span className="tnum">{shop.pan}</span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Left panel, desktop only. Phones give the space to the form instead: on a
 * counter tablet held in one hand, decoration that pushes the password field
 * below the fold is worse than no decoration at all.
 */
function BrandPanel({
  shop,
  address,
}: {
  shop: BusinessSettings;
  address: string;
}) {
  return (
    <div className="login-ground relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14">
      <div className="login-blister absolute inset-0" aria-hidden="true" />

      {/*
        The dispensing cross, the sign that hangs outside every pharmacy. Kept
        almost entirely in frame: a cross cropped to one arm reads as a stray
        rectangle, which is worse than no mark at all.
      */}
      <svg
        className="pointer-events-none absolute -right-10 -bottom-12 h-80 w-80 text-white/[0.055] xl:h-96 xl:w-96"
        viewBox="0 0 100 100"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M38 6h24a6 6 0 016 6v20h20a6 6 0 016 6v24a6 6 0 01-6 6H68v20a6 6 0 01-6 6H38a6 6 0 01-6-6V68H12a6 6 0 01-6-6V38a6 6 0 016-6h20V12a6 6 0 016-6z" />
      </svg>

      <div className="relative flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white shadow-lg shadow-brand-500/20">
          M
        </span>
        <span className="text-[15px] leading-tight font-semibold text-white">
          MantraSphere
          <span className="block text-[11px] font-normal tracking-wide text-slate-400">
            Pharmacy Suite
          </span>
        </span>
      </div>

      <div className="relative max-w-md">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
          Point of sale &amp; inventory
        </p>
        <h2 className="mt-3 text-[2rem] leading-[1.15] font-semibold tracking-tight text-white">
          Billing that keeps your stock honest.
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-slate-400">
          Every sale dispenses the earliest-expiring batch first, deducts stock in
          the same transaction as the bill, and never lets an expired lot reach a
          customer.
        </p>

        <ul className="mt-9 space-y-4">
          {FEATURES.map((feature, index) => (
            <li key={feature.title}>
              {index > 0 ? (
                <div className="login-rule mb-4" aria-hidden="true" />
              ) : null}
              <div className="flex gap-3.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300 ring-1 ring-brand-400/20 ring-inset">
                  {feature.icon}
                </span>
                <div>
                  <p className="text-sm font-medium text-white">{feature.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-slate-400">
                    {feature.detail}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-[11px] text-slate-400">
        {[
          shop.businessName,
          address,
          shop.pan ? `PAN ${shop.pan}` : "",
          shop.drugLicenceNo ? `DDA ${shop.drugLicenceNo}` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

/** Compact lockup for phones, where the brand panel is not rendered at all. */
function MobileBrand() {
  return (
    <div className="mb-6 flex items-center gap-3 lg:hidden">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">
        M
      </span>
      <span className="text-[15px] leading-tight font-semibold text-slate-900">
        MantraSphere
        <span className="block text-[11px] font-normal text-slate-500">
          Pharmacy Suite
        </span>
      </span>
    </div>
  );
}

/**
 * A statement about the session, not a live connection light.
 *
 * A status light that is wrong is worse than no light. The honest live signal
 * is the sign-in attempt itself, which says plainly when the server cannot be
 * reached; this states what is true of every request instead.
 */
function SecureBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 ring-inset">
      <svg
        className="h-3.5 w-3.5 text-brand-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3l7 3v5c0 4.5-2.9 8.3-7 10-4.1-1.7-7-5.5-7-10V6l7-3z"
        />
      </svg>
      Secure session
    </span>
  );
}

const iconClass = "h-4 w-4";

const FEATURES = [
  {
    title: "FEFO dispensing, decided by the system",
    detail:
      "The counter never picks a lot. The earliest-expiring sellable batch is chosen on every line.",
    icon: (
      <svg
        className={iconClass}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 7h16M4 12h10M4 17h6m8-3l3 3-3 3m3-3H14"
        />
      </svg>
    ),
  },
  {
    title: "Expiry and low-stock alerts",
    detail:
      "Graded by what actually sells, so the morning list is what to act on, not everything that is merely old.",
    icon: (
      <svg
        className={iconClass}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 8v4l2.5 2.5M12 21a9 9 0 100-18 9 9 0 000 18z"
        />
      </svg>
    ),
  },
  {
    title: "VAT invoices, print-ready",
    detail:
      "13% VAT, bill numbers from an atomic counter, and an 80mm thermal copy that reprints exactly as issued.",
    icon: (
      <svg
        className={iconClass}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M7 8h10M7 12h6M6 21V5a2 2 0 012-2h8a2 2 0 012 2v16l-3-2-3 2-3-2-3 2z"
        />
      </svg>
    ),
  },
];
