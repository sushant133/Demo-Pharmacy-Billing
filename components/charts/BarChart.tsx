import { compactNumber, horizontalBarPath, niceScale } from "@/lib/chart-scale";
import { money } from "@/lib/format";

/**
 * Horizontal bar chart for ranked categories - top medicines by profit.
 *
 * One series, so one colour for every bar. Shading bars darker-where-bigger
 * would double-encode length as hue and burn the only free channel on
 * information the bar already shows.
 *
 * No legend: with a single series the heading already says what is plotted, so
 * a one-swatch legend box would only restate it.
 */

export interface BarDatum {
  label: string;
  value: number;
  /** Optional second line under the label. */
  sublabel?: string;
  /** Shown in the hover tooltip and the table twin. */
  detail?: string;
}

export interface BarChartProps {
  data: BarDatum[];
  caption: string;
  /** Rendered as money when true, otherwise as a plain count. */
  isMoney?: boolean;
  valueHeader?: string;
}

const ROW_HEIGHT = 30;
const BAR_HEIGHT = 18; // <= 24px, leaving the band's remainder as air
const LABEL_WIDTH = 190;
const VALUE_WIDTH = 74;

export function BarChart({
  data,
  caption,
  isMoney = true,
  valueHeader = "Value",
}: BarChartProps) {
  const width = 720;
  const height = Math.max(ROW_HEIGHT, data.length * ROW_HEIGHT) + 8;
  const trackWidth = width - LABEL_WIDTH - VALUE_WIDTH;

  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const { max } = niceScale(maxValue);

  const format = (value: number) => (isMoney ? money(value) : String(Math.round(value)));

  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Nothing sold in this period.
      </div>
    );
  }

  return (
    <figure className="m-0">
      <div className="table-scroll table-scroll-shadow">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[520px]"
          role="img"
          aria-label={caption}
        >
          {data.map((datum, index) => {
            const y = index * ROW_HEIGHT + 4;
            const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2 - 4;
            const barWidth = max > 0 ? Math.max(0, (datum.value / max) * trackWidth) : 0;

            return (
              <g key={`${datum.label}-${index}`}>
                {/* Category label, truncated by the browser rather than clipped mid-glyph. */}
                <text
                  x={0}
                  y={barY + BAR_HEIGHT / 2 + (datum.sublabel ? -1 : 4)}
                  className="fill-slate-700 text-[11px]"
                >
                  {truncate(datum.label, 30)}
                </text>
                {datum.sublabel ? (
                  <text
                    x={0}
                    y={barY + BAR_HEIGHT / 2 + 10}
                    className="fill-slate-400 text-[10px]"
                  >
                    {truncate(datum.sublabel, 34)}
                  </text>
                ) : null}

                {/* Track, so short bars still read as a proportion. */}
                <rect
                  x={LABEL_WIDTH}
                  y={barY}
                  width={trackWidth}
                  height={BAR_HEIGHT}
                  rx={4}
                  fill="var(--color-chart-grid)"
                  opacity={0.5}
                />

                <path
                  d={horizontalBarPath(LABEL_WIDTH, barY, barWidth, BAR_HEIGHT, 4)}
                  fill="var(--color-series-1)"
                >
                  <title>
                    {`${datum.label}: ${format(datum.value)}${datum.detail ? ` — ${datum.detail}` : ""}`}
                  </title>
                </path>

                {/* Value at the tip, outside the bar so it can never be clipped. */}
                <text
                  x={width - 4}
                  y={barY + BAR_HEIGHT / 2 + 4}
                  textAnchor="end"
                  className="fill-slate-900 text-[11px] font-medium"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {isMoney ? compactNumber(datum.value) : Math.round(datum.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
          View as table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-200">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-slate-600">Item</th>
                <th className="px-3 py-2 text-right font-semibold text-slate-600">
                  {valueHeader}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((datum, index) => (
                <tr key={`${datum.label}-${index}`}>
                  <td className="px-3 py-1.5 text-slate-700">
                    {datum.label}
                    {datum.sublabel ? (
                      <span className="block text-[11px] text-slate-400">
                        {datum.sublabel}
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum px-3 py-1.5 text-right text-slate-700">
                    {format(datum.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
