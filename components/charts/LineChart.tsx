import {
  bandCentres,
  compactNumber,
  linePath,
  niceScale,
  scaleY,
  thinLabels,
} from "@/lib/chart-scale";
import { money } from "@/lib/format";
import { cx } from "@/components/ui";

/**
 * Revenue / profit over time.
 *
 * Server-rendered SVG: no charting library, no client JavaScript. Hover is
 * carried by native `<title>` elements and the values are all reachable in the
 * table twin below, so nothing is gated behind a tooltip.
 *
 * Both series are rupees on one axis. A second y-scale is never used - two
 * arbitrary scales on one plot invent a correlation that is not in the data.
 */

export interface LineSeries {
  key: string;
  label: string;
  /** CSS custom property name for the series colour. */
  color: string;
  values: number[];
}

export interface LineChartProps {
  labels: string[];
  series: LineSeries[];
  height?: number;
  /** Accessible summary; also the visually hidden description. */
  caption: string;
}

const PADDING = { top: 16, right: 56, bottom: 28, left: 52 };

export function LineChart({
  labels,
  series,
  height = 260,
  caption,
}: LineChartProps) {
  const width = 760;
  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;

  const maxValue = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((v) => Number.isFinite(v))),
  );
  const { max, ticks } = niceScale(maxValue);
  const xs = bandCentres(labels.length, plotWidth);
  const keepLabel = thinLabels(labels.length, 8);

  const hasData = labels.length > 0 && maxValue > 0;

  return (
    <figure className="m-0">
      {/* Legend first: identity must never rest on colour matching alone. */}
      <figcaption className="mb-3 flex flex-wrap items-center gap-4">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              aria-hidden="true"
              className="h-0.5 w-4 rounded-full"
              style={{ backgroundColor: `var(${s.color})` }}
            />
            {s.label}
          </span>
        ))}
      </figcaption>

      {!hasData ? (
        <div className="flex h-40 items-center justify-center text-sm text-slate-500">
          No sales in this period.
        </div>
      ) : (
        <div className="table-scroll table-scroll-shadow">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full min-w-[520px]"
            role="img"
            aria-label={caption}
          >
            {/* Gridlines: solid hairlines, one step off the surface. */}
            {ticks.map((tick) => {
              const y = scaleY(tick, max, plotHeight, PADDING.top);
              return (
                <g key={tick}>
                  <line
                    x1={PADDING.left}
                    x2={PADDING.left + plotWidth}
                    y1={y}
                    y2={y}
                    stroke="var(--color-chart-grid)"
                    strokeWidth={1}
                  />
                  <text
                    x={PADDING.left - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    className="fill-slate-500 text-[10px]"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {compactNumber(tick)}
                  </text>
                </g>
              );
            })}

            {/* X-axis labels, thinned rather than rotated or clipped. */}
            {labels.map((label, index) =>
              keepLabel[index] ? (
                <text
                  key={`${label}-${index}`}
                  x={PADDING.left + (xs[index] ?? 0)}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px]"
                >
                  {label}
                </text>
              ) : null,
            )}

            {series.map((s) => {
              const points = s.values.map((value, index) => ({
                x: PADDING.left + (xs[index] ?? 0),
                y: scaleY(value, max, plotHeight, PADDING.top),
              }));
              const last = points[points.length - 1];
              const lastValue = s.values[s.values.length - 1] ?? 0;

              return (
                <g key={s.key}>
                  <path
                    d={linePath(points)}
                    fill="none"
                    stroke={`var(${s.color})`}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />

                  {/*
                    Hover targets. The visible dot is small, so an invisible
                    wider circle carries the hit area and the tooltip.
                  */}
                  {points.map((point, index) => (
                    <circle
                      key={index}
                      cx={point.x}
                      cy={point.y}
                      r={10}
                      fill="transparent"
                      className="cursor-crosshair"
                    >
                      <title>{`${labels[index]} — ${s.label}: ${money(s.values[index] ?? 0)}`}</title>
                    </circle>
                  ))}

                  {/* End marker with a 2px surface ring so crossings stay legible. */}
                  {last ? (
                    <circle
                      cx={last.x}
                      cy={last.y}
                      r={4}
                      fill={`var(${s.color})`}
                      stroke="var(--color-chart-surface)"
                      strokeWidth={2}
                    />
                  ) : null}

                  {/* Direct-label the endpoint only; the axis carries the rest. */}
                  {last ? (
                    <text
                      x={Math.min(last.x + 8, width - 4)}
                      y={last.y + 3.5}
                      className="fill-slate-700 text-[10px] font-medium"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {compactNumber(lastValue)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Table twin - every value reachable without hover. */}
      {hasData ? (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
            View as table
          </summary>
          <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-slate-600">
                    Period
                  </th>
                  {series.map((s) => (
                    <th
                      key={s.key}
                      className="px-3 py-2 text-right font-semibold text-slate-600"
                    >
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {labels.map((label, index) => (
                  <tr key={`${label}-${index}`}>
                    <td className="px-3 py-1.5 text-slate-700">{label}</td>
                    {series.map((s) => (
                      <td
                        key={s.key}
                        className={cx("tnum px-3 py-1.5 text-right text-slate-700")}
                      >
                        {money(s.values[index] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </figure>
  );
}
