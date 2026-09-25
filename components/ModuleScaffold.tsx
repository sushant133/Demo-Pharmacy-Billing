import Link from "next/link";
import type { ReactNode } from "react";
import { Card, cx } from "@/components/ui";

/**
 * Shared furniture for the modules the new sidebar opened up.
 *
 * Several menu entries - Invoices, Prescriptions, Expenses, the stock
 * movement views - now have a route and a place in the navigation before they
 * have a feature behind them. Rather than leave those links dead, each gets a
 * real screen in the house style: the same header, the same tab strip, and an
 * honest panel saying what is not wired up yet and where the nearest working
 * screen is.
 *
 * `NotWiredYet` is deliberately plain about its own status. A placeholder that
 * looks finished is worse than no placeholder at all: someone will ship it.
 */

export interface ModuleTab {
  href: string;
  label: string;
}

/** Horizontal tab strip, matching the one on the alerts screen. */
export function ModuleTabs({
  tabs,
  active,
}: {
  tabs: ModuleTab[];
  /** href of the current tab. */
  active: string;
}) {
  return (
    <Card className="mt-4 mb-4 p-3 sm:p-4">
      {/*
        Wraps rather than scrolls: six short tab labels take two lines on a
        phone, which is cheaper than a scroll container the user has to
        discover to find the tab they want.
      */}
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cx(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              tab.href === active
                ? "bg-brand-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </Card>
  );
}

/**
 * The panel a not-yet-built module shows in place of its data.
 *
 * `covers` lists what the screen will do once it exists; `insteadUse` points
 * at the screen that answers the same question today, so nobody is left
 * staring at an apology with nowhere to go.
 */
export function NotWiredYet({
  title,
  description,
  covers,
  insteadUse,
}: {
  title: string;
  description: string;
  covers?: string[];
  insteadUse?: { href: string; label: string };
}) {
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l2.5 2.5M12 21a9 9 0 110-18 9 9 0 010 18z"
            />
          </svg>
        </span>

        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-1 max-w-xl text-sm text-slate-500">{description}</p>

          {covers?.length ? (
            <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {covers.map((entry) => (
                <li key={entry} className="flex items-start gap-2 text-sm text-slate-600">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                  {entry}
                </li>
              ))}
            </ul>
          ) : null}

          {insteadUse ? (
            <Link href={insteadUse.href} className="btn-secondary mt-5 inline-flex">
              {insteadUse.label}
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** Small labelled figure, for the summary rows on the new screens. */
export function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </p>
      <p className="tnum mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
