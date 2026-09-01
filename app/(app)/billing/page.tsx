import type { Metadata } from "next";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { branchForWrite } from "@/lib/branches";
import { BillingScreen } from "@/components/billing/BillingScreen";

export const metadata: Metadata = { title: "New sale" };
export const dynamic = "force-dynamic";

/**
 * Server component wrapper: it resolves the session and outlet, then hands
 * off to the one genuinely interactive part of the app.
 *
 * The outlet lookup is the one thing here that can refuse, and this is the
 * till - the screen a queue is standing in front of. An unhandled throw in a
 * server component renders Next's generic error page, which in a production
 * build says only "a server-side exception has occurred" and a digest number:
 * no use to the person at the counter and no use to whoever they ring. So the
 * refusal is caught and shown as what it is, with the way out of it.
 */
export default async function BillingPage() {
  const user = await requirePagePermission("sale:create");

  let outlet;
  try {
    outlet = await withDbRead(() => branchForWrite(user));
  } catch (error) {
    if (error instanceof ApiError) return <CannotBill reason={error.message} />;
    throw error;
  }

  return <BillingScreen cashierName={user.name} outletName={outlet.name} />;
}

/**
 * Shown instead of the till when no outlet can be billed against.
 *
 * Rare, and always a setup problem rather than a bug in the sale: a closed
 * branch, or an account nobody has attached to one.
 */
function CannotBill({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
        <svg
          className="h-6 w-6"
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
      </span>

      <h1 className="mt-4 text-lg font-semibold text-slate-900">
        Billing is not available at this outlet
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{reason}</p>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/branches" className="btn-primary">
          Open Branches
        </Link>
        <Link href="/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Nothing has been lost &mdash; no bill was started. Stock and past sales
        are unaffected.
      </p>
    </div>
  );
}
