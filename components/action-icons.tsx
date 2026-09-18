import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * The actions column, as icons.
 *
 * An actions column written out in words - "View details  Print  Edit  Add
 * stock" - is the widest column on half these screens, and it grows with
 * every extra permission the signed-in role happens to hold, pushing the
 * numbers people actually came to read off the side of a laptop. Icons hold
 * that column to a fixed width no matter how many controls a row earns.
 *
 * Nothing is lost to anyone who does not recognise a glyph: every control
 * carries its name as an `aria-label` for screen readers and shows it as a
 * tooltip on hover and on keyboard focus. The glyphs are the same 24x24
 * stroked set the sidebar uses, drawn at 18px, rather than emoji - emoji are
 * rendered by the operating system, so the same row would come out as flat
 * outlines on Windows, colour on Android and something else again inside the
 * Capacitor shell, which is the opposite of consistent.
 */

const glyph = (node: ReactNode) => (
  <svg
    className="h-[18px] w-[18px]"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {node}
  </svg>
);

const dot = (cy: number) => (
  <circle key={cy} cx={12} cy={cy} r={1.4} fill="currentColor" stroke="none" />
);

/**
 * One glyph per *meaning*, not per screen: "Edit" is the same pencil on a
 * medicine, an expense, a branch and a draft GRN, so the column can be read
 * by shape once and never re-learned.
 */
export const ACTION_ICONS = {
  /** Open the record's own screen. */
  view: glyph(
    <>
      <path d="M2.25 12S5.75 5.25 12 5.25 21.75 12 21.75 12 18.25 18.75 12 18.75 2.25 12 2.25 12Z" />
      <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </>,
  ),
  /** Thermal / A4 print view. */
  print: glyph(
    <>
      <path d="M6.75 8.25V3.75h10.5v4.5" />
      <path d="M6.75 18h-1.5A2.25 2.25 0 0 1 3 15.75v-4.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v4.5A2.25 2.25 0 0 1 18.75 18h-1.5" />
      <path d="M6.75 14.25h10.5v6H6.75z" />
    </>,
  ),
  /** Open the edit form for this row. */
  edit: glyph(
    <>
      <path d="M16.5 3.75a1.94 1.94 0 0 1 2.75 2.75L8.25 17.5l-3.75 1 1-3.75L16.5 3.75Z" />
      <path d="M14.75 5.5l3.75 3.75" />
    </>,
  ),
  /** Download a generated document. */
  pdf: glyph(
    <>
      <path d="M12 3.75v10.5m0 0 4-4m-4 4-4-4" />
      <path d="M4.5 14.25v4.5A1.5 1.5 0 0 0 6 20.25h12a1.5 1.5 0 0 0 1.5-1.5v-4.5" />
    </>,
  ),
  /** Bring units in - a purchase, a GRN. */
  add: glyph(
    <>
      <path d="M12 8.25v7.5m3.75-3.75h-7.5" />
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </>,
  ),
  /** Correct a count in either direction. */
  adjust: glyph(
    <>
      <path d="M16 3.75 20.25 8 16 12.25" />
      <path d="M20.25 8H8.5A4.5 4.5 0 0 0 4 12.5v.75" />
      <path d="M8 20.25 3.75 16 8 11.75" />
      <path d="M3.75 16H15.5a4.5 4.5 0 0 0 4.5-4.5v-.75" />
    </>,
  ),
  /** Take the record out of use without deleting it. */
  deactivate: glyph(
    <>
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      <path d="M5.64 5.64l12.72 12.72" />
    </>,
  ),
  /** Put it back into use. */
  activate: glyph(
    <>
      <path d="M8.75 12.25 11 14.5l4.5-4.5" />
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </>,
  ),
  /** Remove the record for good. */
  delete: glyph(
    <>
      <path d="M4.5 7h15" />
      <path d="M9.75 4h4.5v3h-4.5z" />
      <path d="M6.75 7 7.8 19.6a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17.25 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </>,
  ),
  /** Start a new record from this one. */
  duplicate: glyph(
    <>
      <path d="M9 9V5.25A1.25 1.25 0 0 1 10.25 4h8.5A1.25 1.25 0 0 1 20 5.25v8.5A1.25 1.25 0 0 1 18.75 15H15" />
      <path d="M5.25 9h8.5A1.25 1.25 0 0 1 15 10.25v8.5A1.25 1.25 0 0 1 13.75 20h-8.5A1.25 1.25 0 0 1 4 18.75v-8.5A1.25 1.25 0 0 1 5.25 9Z" />
    </>,
  ),
  /** Overflow, for rows that outgrow the inline set. */
  more: glyph(<>{[5.5, 12, 18.5].map(dot)}</>),
  /** Take money in, or pay it out. */
  money: glyph(
    <>
      <path d="M3.75 8.25h16.5a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5v-4.5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M14.25 12a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
    </>,
  ),
  /** The batch register for one medicine. */
  lots: glyph(
    <>
      <path d="M12 3.25 3 7.75l9 4.5 9-4.5-9-4.5Z" />
      <path d="M3 12.25l9 4.5 9-4.5" />
      <path d="M3 16.5l9 4.5 9-4.5" />
    </>,
  ),
  /** A printed slip that already exists - a refund receipt. */
  receipt: glyph(
    <>
      <path d="M7.5 3.25h9a1.5 1.5 0 0 1 1.5 1.5v16l-2.25-1.5-2.25 1.5L12 19.25l-1.5 1.5-2.25-1.5L6 20.75v-16a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M9 8.25h6M9 11.5h6" />
    </>,
  ),
  /** The bills raised against somebody. */
  invoices: glyph(
    <>
      <path d="M6.75 3.75h10.5a1.5 1.5 0 0 1 1.5 1.5v13.5a1.5 1.5 0 0 1-1.5 1.5H6.75a1.5 1.5 0 0 1-1.5-1.5V5.25a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M8.75 8.25h6.5M8.75 12h6.5M8.75 15.75h4" />
    </>,
  ),
} as const;

export type ActionIconName = keyof typeof ACTION_ICONS;

/**
 * `primary` for the one action a row is mostly clicked for, `danger` for
 * anything destructive, `success` for a restore. Everything else stays
 * neutral, so a row does not turn into a row of traffic lights.
 */
export type ActionTone = "default" | "primary" | "success" | "danger";

const TONES: Record<ActionTone, string> = {
  default: "",
  primary: "action-icon-primary",
  success: "action-icon-success",
  danger: "action-icon-danger",
};

/** The flex row an actions cell puts its icons in. */
export function ActionBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-end gap-0.5 whitespace-nowrap",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface ActionIconProps {
  /** The action's name. Announced, and shown as the tooltip. */
  label: string;
  icon: ActionIconName;
  /** Internal destination; routed through `next/link`. */
  href?: string;
  /**
   * Sends `href` to a plain anchor instead. For API downloads, which are
   * files rather than routes and would only navigate the router away.
   */
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  tone?: ActionTone;
  className?: string;
}

/**
 * One control in an actions column.
 *
 * Renders as a link, an anchor or a button depending on what it is given, so
 * a navigation stays a navigation - middle-clickable, openable in a new tab -
 * rather than becoming a button that happens to move the page.
 */
export function ActionIcon({
  label,
  icon,
  href,
  external,
  onClick,
  disabled,
  tone = "default",
  className,
}: ActionIconProps) {
  const classes = cx("action-icon", TONES[tone], className);
  const body = (
    <>
      {ACTION_ICONS[icon]}
      <span className="action-tip" aria-hidden="true">
        {label}
      </span>
    </>
  );

  if (href && !disabled) {
    return external ? (
      <a href={href} aria-label={label} className={classes}>
        {body}
      </a>
    ) : (
      <Link href={href} aria-label={label} className={classes}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={classes}
    >
      {body}
    </button>
  );
}
