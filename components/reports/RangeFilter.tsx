import Link from "next/link";
import { addDays, toDateInputValue } from "@/lib/dates";
import { Card, cx } from "@/components/ui";

/**
 * One filter row, above everything it scopes.
 *
 * Per-chart filters are an anti-pattern: every chart on the page must re-render
 * against the same slice, so the range lives here once and travels in the URL.
 * A plain GET form means no client JavaScript and a shareable link.
 */

export interface ResolvedRange {
  from: string;
  to: string;
  label: string;
  preset: string;
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "year", label: "This year" },
] as const;

/**
 * Turn `?preset=` or explicit `?from=&to=` into concrete dates.
 * Explicit dates always win, so a bookmarked custom range survives.
 */
export function resolveRange(params: {
  preset?: string;
  from?: string;
  to?: string;
}): ResolvedRange {
  const today = new Date();

  if (params.from || params.to) {
    const from = params.from ?? toDateInputValue(addDays(today, -29));
    const to = params.to ?? toDateInputValue(today);
    return { from, to, label: `${from} to ${to}`, preset: "custom" };
  }

  const preset = params.preset ?? "30d";
  const to = toDateInputValue(today);

  switch (preset) {
    case "today":
      return { from: to, to, label: "Today", preset };
    case "7d":
      return {
        from: toDateInputValue(addDays(today, -6)),
        to,
        label: "Last 7 days",
        preset,
      };
    case "90d":
      return {
        from: toDateInputValue(addDays(today, -89)),
        to,
        label: "Last 90 days",
        preset,
      };
    case "year": {
      const jan1 = new Date(today.getFullYear(), 0, 1);
      return {
        from: toDateInputValue(jan1),
        to,
        label: "This year",
        preset,
      };
    }
    default:
      return {
        from: toDateInputValue(addDays(today, -29)),
        to,
        label: "Last 30 days",
        preset: "30d",
      };
  }
}

export function RangeFilter({
  basePath,
  range,
  extra,
}: {
  basePath: string;
  range: ResolvedRange;
  /** Additional controls rendered on the right, e.g. export buttons. */
  extra?: React.ReactNode;
}) {
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((preset) => (
            <Link
              key={preset.key}
              href={`${basePath}?preset=${preset.key}`}
              className={cx(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                range.preset === preset.key
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {preset.label}
            </Link>
          ))}
        </div>

        {extra ? <div className="flex flex-wrap gap-2">{extra}</div> : null}
      </div>

      <form
        method="get"
        action={basePath}
        className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3"
      >
        <div>
          <label htmlFor="from" className="label">
            From
          </label>
          <input
            id="from"
            type="date"
            name="from"
            defaultValue={range.from}
            className="input w-40"
          />
        </div>
        <div>
          <label htmlFor="to" className="label">
            To
          </label>
          <input
            id="to"
            type="date"
            name="to"
            defaultValue={range.to}
            className="input w-40"
          />
        </div>
        <button type="submit" className="btn-secondary">
          Apply custom range
        </button>
        {range.preset === "custom" ? (
          <span className="text-xs text-slate-500">
            Showing {range.from} to {range.to}
          </span>
        ) : null}
      </form>
    </Card>
  );
}
