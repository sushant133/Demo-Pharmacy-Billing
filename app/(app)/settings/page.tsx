import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { hasMultipleBranches } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { getSettings, platformIdentity, vatPercent } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings/SettingsForm";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * The shop's own details.
 *
 * Split in two, and the split is the point. The premises, the phone, the
 * terms and the footer line are the shop's: an owner who has moved should be
 * able to correct the bill header without anyone touching a server. The
 * registered identity - both names, the PAN, the VAT number and the licences
 * - is MantraMed's, shown here read-only, because a shop that can type its
 * own PAN can issue tax invoices under a number nobody verified.
 */
export default async function SettingsPage() {
  const user = await requirePagePermission("settings:manage");
  const [settings, multiBranch] = await withDbRead(() =>
    Promise.all([
      getSettings(user.pharmacyId, user.pharmacyName),
      hasMultipleBranches(user),
    ]),
  );

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Your pharmacy's name, registration and contact details. These print on every bill."
      />

      {!settings.pan ? (
        <div className="mb-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <svg
            className="mt-px h-5 w-5 shrink-0 text-amber-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
            />
          </svg>
          <span>
            <strong className="font-semibold">No PAN is set.</strong> A tax
            invoice without the seller&apos;s PAN is not valid, so every bill
            printed until this is filled in carries a gap where the number
            should be. Send yours to MantraMed support and it will be added
            to your registered identity below.
          </span>
        </div>
      ) : null}

      <SettingsForm
        initial={{ ...settings, vatRate: vatPercent(settings) }}
        identity={platformIdentity(settings)}
      />

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
        Running more than one outlet? A branch may print its own name, address,
        phone and PAN &mdash; a VAT invoice has to carry the identity of the
        outlet that issued it. Anything a branch leaves blank falls back to what
        is set here.{" "}
        {multiBranch ? (
          <>
            Set those on the{" "}
            <Link
              href="/branches"
              className="font-medium text-brand-700 hover:underline"
            >
              Branches
            </Link>{" "}
            screen.
          </>
        ) : (
          <>
            Ask MantraMed support to open a second outlet for this pharmacy
            and a Branches screen appears here for it.
          </>
        )}
      </p>
    </>
  );
}
