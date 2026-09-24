import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { DesktopDownloadLink } from "@/components/DesktopDownloadLink";
import { LoginForm } from "@/components/LoginForm";
import { cx } from "@/components/ui";
import { adToBs, formatBs, nepaliFiscalYear } from "@/lib/bs-date";
import { config } from "@/lib/config";
import { localParts } from "@/lib/dates";

export const metadata: Metadata = { title: "Sign in" };

/**
 * The supplied emblem, and its intrinsic size.
 *
 * Declared once so both lockups hand next/image the same aspect ratio: the
 * dimensions are what reserves the space before the file arrives, and two
 * copies of them are two chances for one to drift and start shifting the
 * page on load.
 */
const LOGO = { src: "/mantramed-logo.png", width: 1254, height: 1254 } as const;

/**
 * Sign-in screen.
 *
 * Server component around one interactive island, so the date and the
 * branding render on the server and only the credential form ships
 * JavaScript.
 *
 * This is the platform's front door, not any one shop's. Every pharmacy on
 * MantraMed signs in through this same URL, so nothing here names a
 * tenant: a screen headed "Mantra Pharmacy" is wrong for every vendor except
 * one, and the deployment default it used to read is not a real pharmacy at
 * all. The shop's own identity appears once it is known, which is after
 * sign-in.
 *
 * What is safe to show before then is what is true for everyone: the product,
 * both calendars and the fiscal year that bills are filed under. A stranger
 * who found the URL should learn nothing they could use; staff opening the
 * counter should still be able to tell at a glance that this is the right
 * terminal on the right day.
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
  const next = safeNext ?? "/";

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

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] xl:grid-cols-2">
      <BrandPanel />

      {/* Counter panel */}
      <div className="login-counter flex flex-col justify-center px-4 py-10 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-[26rem]">
          <MobileBrand />

          <div className="login-card overflow-hidden">
            <div className="px-5 py-6 sm:px-7 sm:py-7">
              {/*
                The badge sits with the heading rather than in a strip of its
                own. The strip used to carry the shop's name, and on a
                platform every pharmacy signs into, there is no shop to name
                until someone has signed in.
              */}
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-slate-900">
                  Sign in
                </h1>
                <SecureBadge />
              </div>
              <p className="mt-1.5 text-sm text-slate-500">
                {safeNext && safeNext !== "/" ? (
                  <>
                    Sign in to continue to{" "}
                    <span className="font-medium text-slate-700">{safeNext}</span>.
                  </>
                ) : (
                  "Pharmacy owners open their shop. The platform administrator opens the account panel."
                )}
              </p>

              <div className="mt-6">
                <LoginForm
                  next={next}
                  demo={
                    config.isProd
                      ? null
                      : [
                          {
                            label: "Pharmacy owner",
                            email:
                              process.env.SEED_ADMIN_EMAIL ??
                              "admin@mantrapharma.local",
                            password:
                              process.env.SEED_ADMIN_PASSWORD ?? "Admin@123",
                          },
                          {
                            label: "Superadmin",
                            email:
                              process.env.SEED_SUPERADMIN_EMAIL ??
                              "superadmin@mantrapharma.local",
                            password:
                              process.env.SEED_SUPERADMIN_PASSWORD ?? "Super@123",
                          },
                        ]
                  }
                />
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

          <p className="mt-3 text-center text-xs">
            <Link
              href="/privacy"
              className="text-slate-500 underline underline-offset-2 hover:text-slate-700"
            >
              Privacy policy
            </Link>
          </p>

          <DesktopDownloadLink />

          {/*
            Phones only. On a desktop the same imprint sits at the foot of the
            brand panel, which is not rendered here.
          */}
          <div className="mt-6 lg:hidden">
            <PackImprint tone="light" />
          </div>
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
function BrandPanel() {
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

      {/*
        Emblem, name, descriptor - the ordinary three-part lockup.

        The emblem carries a wordmark of its own, so it is held to a size
        where that reads as detail inside the mark rather than as a second
        name competing with the type beside it. Blown up large it does
        compete, and the eye has to decide which of two "MantraMed"s is the
        heading.

        It sits on a white disc because it is drawn for light ground: the
        upper arc and the "Mantra" half of its word are dark navy, which on
        this near-black panel would leave half the mark invisible. The disc
        follows the emblem's own circle rather than boxing it.
      */}
      <div className="relative flex items-center gap-4">
        <span className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full bg-white p-2 shadow-xl shadow-brand-950/40 ring-1 ring-white/20">
          <Image
            src={LOGO.src}
            alt=""
            width={LOGO.width}
            height={LOGO.height}
            priority
            className="h-full w-full object-contain"
          />
        </span>
        <span className="min-w-0">
          <span className="block text-[34px] leading-none font-semibold tracking-tight text-white">
            MantraMed
          </span>
          <span className="mt-2 block text-[11px] font-semibold tracking-[0.2em] text-brand-300 uppercase">
            Pharmacy Suite
          </span>
        </span>
      </div>

      <div className="relative max-w-md">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
          Point of sale &amp; inventory
        </p>
        {/*
          A step below the wordmark above it. At the same size the two read as
          rival headings on one panel, and the product name loses - it is the
          shorter string and it sits further from the eye's landing point.
        */}
        <h2 className="mt-3 text-[1.75rem] leading-[1.2] font-semibold tracking-tight text-white">
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

      {/* Same measure as the headline above it, so the column reads as one. */}
      <div className="relative max-w-md">
        <PackImprint tone="dark" />
      </div>
    </div>
  );
}

/**
 * Who made the software, written the way a pack says who made the medicine.
 *
 * Every carton on the shelf behind this counter carries the same block in the
 * same order - a tear line, "A product of" in small caps, then the name - and
 * a pharmacist reads it a hundred times a day. Borrowing it is the one credit
 * on this screen that belongs to the room it is standing in, rather than a
 * copyright notice lifted from the bottom of a marketing site.
 *
 * Given weight on purpose. A maker's mark whispered in 9pt grey is a maker's
 * mark nobody reads, and on a pack this panel is printed to be legible at
 * arm's length across a dispensary - so it gets a framed panel, a solid
 * brand-coloured cross and a name at a size the eye actually stops on.
 *
 * Only what is true goes on it. A real pack imprint also carries a licence
 * number, a batch and a plant address, and inventing any of those to complete
 * the picture is the one thing that would make the whole conceit dishonest.
 */
function PackImprint({ tone }: { tone: "dark" | "light" }) {
  const dark = tone === "dark";

  return (
    <div className="space-y-3">
      {/* The tear line, as on the flap it would be printed under. */}
      <div
        className={cx(
          "border-t border-dashed",
          dark ? "border-white/20" : "border-slate-300",
        )}
        aria-hidden="true"
      />

      <div
        className={cx(
          "flex items-center gap-3.5 rounded-xl border px-4 py-3.5",
          dark
            ? "border-white/12 bg-white/[0.045]"
            : "border-slate-200 bg-white shadow-sm",
        )}
      >
        {/* The dispensing cross, as the maker's mark. */}
        <span
          className={cx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white",
            dark
              ? "bg-brand-500 shadow-lg shadow-brand-500/25"
              : "bg-brand-600 shadow-sm",
          )}
          aria-hidden="true"
        >
          <svg className="h-5 w-5" viewBox="0 0 100 100" fill="currentColor">
            <path d="M38 6h24a6 6 0 016 6v20h20a6 6 0 016 6v24a6 6 0 01-6 6H68v20a6 6 0 01-6 6H38a6 6 0 01-6-6V68H12a6 6 0 01-6-6V38a6 6 0 016-6h20V12a6 6 0 016-6z" />
          </svg>
        </span>

        <p className="min-w-0">
          <span
            className={cx(
              "block text-[10px] font-bold tracking-[0.2em] uppercase",
              dark ? "text-brand-300" : "text-brand-700",
            )}
          >
            A product of
          </span>
          <span
            className={cx(
              "mt-0.5 block text-[15px] leading-snug font-semibold tracking-tight",
              dark ? "text-white" : "text-slate-900",
            )}
          >
            MantraSphere Innovations Pvt.&nbsp;Ltd.
          </span>
        </p>
      </div>
    </div>
  );
}

/** Compact lockup for phones, where the brand panel is not rendered at all. */
function MobileBrand() {
  return (
    // Light ground here, so the emblem needs no disc behind it. Centred above
    // the card because on a phone it is the first thing on the screen, and
    // laid out sideways so the lockup costs height the password field wants.
    <div className="mb-6 flex items-center justify-center gap-3.5 lg:hidden">
      <Image
        src={LOGO.src}
        alt=""
        width={LOGO.width}
        height={LOGO.height}
        priority
        className="h-[72px] w-[72px] shrink-0 object-contain"
      />
      <span className="min-w-0">
        <span className="block text-[27px] leading-none font-semibold tracking-tight text-slate-900">
          MantraMed
        </span>
        <span className="mt-1.5 block text-[10px] font-semibold tracking-[0.18em] text-brand-700 uppercase">
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
