import Link from "next/link";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Small presentational primitives shared across screens.
 *
 * All server-renderable: none of these hold state, so pages stay server
 * components until real interactivity forces otherwise.
 */

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  /*
    `min-w-0` on the title block, and the actions allowed to wrap onto their
    own line. Without the first, a long pharmacy or report name sets the
    flex item's minimum width and shoves the buttons past the right edge -
    which on a phone is how the whole page ended up draggable sideways.
  */
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2 sm:mb-6">
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <h1 className="text-lg font-semibold tracking-tight text-balance text-slate-900 sm:text-xl lg:text-2xl">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-pretty text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "brand" | "warning" | "danger";
  href?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-slate-200",
    brand: "border-brand-200 bg-brand-50/40",
    warning: "border-amber-200 bg-amber-50/50",
    danger: "border-rose-200 bg-rose-50/50",
  };

  const body = (
    <div
      className={cx(
        "card @container h-full p-4 transition-shadow sm:p-5",
        tones[tone],
        href && "hover:shadow-md",
      )}
    >
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase sm:text-xs">
        {label}
      </p>
      {/*
        A four-figure rupee total at `text-3xl` does not fit two-up on a
        360px phone, and these tiles are always laid out two-up. The figure
        steps down with the tile, and never splits mid-number - see
        `.stat-figure` in app/globals.css.
      */}
      <p className="stat-figure tnum mt-1.5 font-semibold text-slate-900 sm:mt-2">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] text-pretty text-slate-500 sm:text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );

  /*
    `next/link`, not a bare anchor.

    These tiles were plain `<a href>`, which makes every click a full document
    reload: the whole app shell, the sidebar and the session lookup all rebuilt
    to move between two views of the same data. Half the screens in this app
    now have a clickable tile, so it was the most-hit slow path in the UI.
  */
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:outline-2">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Badge({
  children,
  tone = "slate",
  className,
}: {
  children: ReactNode;
  tone?: "slate" | "brand" | "green" | "amber" | "rose";
  className?: string;
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
    brand: "bg-brand-100 text-brand-800 ring-brand-200",
    green: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    amber: "bg-amber-100 text-amber-800 ring-amber-200",
    rose: "bg-rose-100 text-rose-700 ring-rose-200",
  };
  return <span className={cx("badge", tones[tone], className)}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <svg
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Scroll container plus the one `<table>`.
 *
 * Children must be `<thead>` / `<tbody>` / `<tfoot>`. A nested `<table>`
 * (stale Fast Refresh still emitting one) is unwrapped rather than nested.
 */
function rowsFrom(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  if (items.length === 1 && isValidElement(items[0])) {
    const el = items[0] as ReactElement<{ children?: ReactNode }>;
    if (el.type === "table") return rowsFrom(el.props.children);
  }
  return children;
}

/**
 * The wrapper every list table uses.
 *
 * Every column is shown at every width. A table that does not fit scrolls
 * sideways inside this box - it is never cut off, and it never widens the
 * page, which is what the old `md:overflow-x-visible` did: a wide table was
 * handed back to the document, and since most of these sit in a card with
 * `overflow-hidden` for its corners, the last column was simply clipped.
 *
 * `minWidth` is the width below which the columns stop being readable and
 * the table should scroll instead of squeezing. Without it a table will
 * happily compress a date column until it wraps to four lines, which is
 * technically "fitting" and useless in practice. Roughly 5-6rem per column
 * is a good starting point; numeric columns need less, names more.
 *
 * `pinFirst` and `pinLast` hold the identifying column and the actions
 * against the two edges while the middle scrolls between them.
 */
export function TableWrap({
  children,
  minWidth,
  pinFirst,
  pinLast,
  className,
}: {
  children: ReactNode;
  /** e.g. `"44rem"`. The width below which this table should scroll. */
  minWidth?: string;
  /** Keeps the first column visible while the rest scrolls under it. */
  pinFirst?: boolean;
  /** Keeps the last column - the actions - against the right edge. */
  pinLast?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "table-scroll table-scroll-shadow",
        pinFirst && "table-pin-first",
        pinLast && "table-pin-last",
        className,
      )}
    >
      <table
        className="w-full border-collapse text-sm"
        style={minWidth ? { minWidth } : undefined}
      >
        {rowsFrom(children)}
      </table>
    </div>
  );
}

/**
 * No-op kept so a stale Fast Refresh tree that still wraps rows in `<Table>`
 * cannot nest a second `<table>` inside TableWrap.
 */
export function Table({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Pagination({
  page,
  totalPages,
  total,
  baseHref,
}: {
  page: number;
  totalPages: number;
  total: number;
  baseHref: string;
}) {
  if (totalPages <= 1) {
    return (
      <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        {total} record{total === 1 ? "" : "s"}
      </div>
    );
  }

  const join = (target: number) =>
    baseHref + (baseHref.includes("?") ? "&" : "?") + "page=" + target;

  /*
    A disabled step is a `<button disabled>`, not a dead link.

    These were anchors with `pointer-events-none`, which hides them from the
    mouse but leaves them in the tab order and announced as links - so keyboard
    and screen-reader users could still reach and follow "Previous" on page 1.
    A disabled button is unreachable and announced as disabled, which is what
    the greying-out has always meant.
  */
  const step = (label: string, target: number, disabled: boolean) =>
    disabled ? (
      <button
        type="button"
        disabled
        className="btn-secondary px-3 py-1.5 text-xs opacity-40"
      >
        {label}
      </button>
    ) : (
      <Link href={join(target)} className="btn-secondary px-3 py-1.5 text-xs">
        {label}
      </Link>
    );

  /*
    The count and the steps sit on one line where there is room and stack
    where there is not, rather than the count being squeezed to two words per
    line beside the buttons on a phone.
  */
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
      <p className="text-xs text-slate-500">
        Page {page} of {totalPages} &middot; {total} record
        {total === 1 ? "" : "s"}
      </p>
      <div className="flex shrink-0 gap-2">
        {step("Previous", page - 1, page <= 1)}
        {step("Next", page + 1, page >= totalPages)}
      </div>
    </div>
  );
}
