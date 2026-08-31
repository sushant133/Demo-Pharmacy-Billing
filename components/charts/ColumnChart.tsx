import {
  compactNumber,
  niceScale,
  scaleY,
  thinLabels,
  verticalBarPath,
} from "@/lib/chart-scale";
import { money } from "@/lib/format";

/**
 * Vertical columns for a short series - typically today's hours.
 *
 * Same rules as LineChart: zero baseline, nice ticks, native tooltips, no
 * client JavaScript. A quiet track behind every column keeps empty hours
 * readable as "nothing yet" rather than missing.
 */

export interface ColumnDatum {
  label: string;
  value: number;
  /** Extra line in the hover title. */
  detail?: string;
}

export interface ColumnChartProps {
  data: ColumnDatum[];
  caption: string;
  isMoney?: boolean;
  height?: number;
  /** Index of the column to emphasise (the current hour). */
  highlightIndex?: number;
}

const PADDING = { top: 12, right: 12, bottom: 24, left: 44 };

export function ColumnChart({
  data,
  caption,
  isMoney = true,
  height = 200,
  highlightIndex,
}: ColumnChartProps) {
  const width = 640;
  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;
  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const { max, ticks } = niceScale(maxValue);
  const keepLabel = thinLabels(data.length, 10);
  const gap = 4;
  const band = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.max(2, band - gap);
  const format = (value: number) => (isMoney ? money(value) : String(Math.round(value)));

  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Nothing to plot yet.
      </div>
    );
  }

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[360px]"
          role="img"
          aria-label={caption}
        >
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
                  {isMoney ? compactNumber(tick) : tick}
                </text>
              </g>
            );
          })}

          {data.map((datum, index) => {
            const x = PADDING.left + index * band + (band - barWidth) / 2;
            const barHeight =
              max > 0 ? Math.max(datum.value > 0 ? 2 : 0, (datum.value / max) * plotHeight) : 0;
            const y = PADDING.top + plotHeight - barHeight;
            const isLast = highlightIndex === index;

            return (
              <g key={`${datum.label}-${index}`}>
                <rect
                  x={x}
                  y={PADDING.top}
                  width={barWidth}
                  height={plotHeight}
                  rx={3}
                  fill="var(--color-chart-grid)"
                  opacity={0.35}
                />
                {barHeight > 0 ? (
                  <path
                    d={verticalBarPath(x, y, barWidth, barHeight, 3)}
                    fill={isLast ? "var(--color-brand-600)" : "var(--color-series-1)"}
                  >
                    <title>
                      {`${datum.label}: ${format(datum.value)}${datum.detail ? ` — ${datum.detail}` : ""}`}
                    </title>
                  </path>
                ) : null}
                {keepLabel[index] ? (
                  <text
                    x={x + barWidth / 2}
                    y={height - 8}
                    textAnchor="middle"
                    className="fill-slate-500 text-[10px]"
                  >
                    {datum.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
