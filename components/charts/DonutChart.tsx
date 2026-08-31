import { donutSlicePath } from "@/lib/chart-scale";
import { cx } from "@/components/ui";

/**
 * Share-of-total chart: payment mix, category mix.
 *
 * Server-rendered SVG. Colour is a hint; every slice is named in the legend
 * with its percentage, so nothing is knowable only by matching a hue.
 */

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** CSS custom property, e.g. `--color-series-1`. */
  color: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  caption: string;
  /** Figure in the hole, typically the total. */
  centerLabel?: string;
  centerHint?: string;
  formatValue?: (value: number) => string;
}

const SIZE = 180;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER = 74;
const INNER = 46;
const GAP = 1.6;

export function DonutChart({
  slices,
  caption,
  centerLabel,
  centerHint,
  formatValue = (value) => String(value),
}: DonutChartProps) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const visible = slices.filter((slice) => slice.value > 0);

  if (visible.length === 0 || total <= 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Nothing to plot yet.
      </div>
    );
  }

  let cursor = 0;

  return (
    <figure className="m-0">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-40 w-40 shrink-0"
          role="img"
          aria-label={caption}
        >
          {visible.map((slice) => {
            const sweep = (slice.value / total) * 360;
            const start = cursor;
            const end = cursor + sweep;
            cursor = end;
            const pad = visible.length > 1 && sweep > GAP * 2 ? GAP / 2 : 0;
            const d = donutSlicePath(CX, CY, OUTER, INNER, start + pad, end - pad);

            return (
              <path key={slice.key} d={d} fill={`var(${slice.color})`}>
                <title>
                  {`${slice.label}: ${formatValue(slice.value)} (${pct(slice.value, total)})`}
                </title>
              </path>
            );
          })}

          {centerLabel ? (
            <text
              x={CX}
              y={centerHint ? CY - 2 : CY + 5}
              textAnchor="middle"
              className="fill-slate-900 text-[15px] font-semibold"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {centerLabel}
            </text>
          ) : null}
          {centerHint ? (
            <text
              x={CX}
              y={CY + 14}
              textAnchor="middle"
              className="fill-slate-500 text-[10px]"
            >
              {centerHint}
            </text>
          ) : null}
        </svg>

        <ul className="w-full min-w-0 space-y-2">
          {slices.map((slice) => (
            <li key={slice.key} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2 text-slate-700">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(${slice.color})` }}
                />
                <span className="truncate">{slice.label}</span>
              </span>
              <span className={cx("tnum shrink-0 font-medium text-slate-900")}>
                {pct(slice.value, total)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((value / total) * 100).toFixed(0)}%`;
}
