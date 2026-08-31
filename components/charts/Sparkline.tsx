import { bandCentres, linePath, scaleY } from "@/lib/chart-scale";

/**
 * A week of revenue in the width of a card.
 *
 * Server-rendered SVG like the other charts here: no library, no client
 * JavaScript. It carries shape only - "steady", "climbing", "one big day" -
 * and every number it is drawn from is written out in the text beside it, so
 * nothing is knowable only by squinting at the line.
 *
 * The box is stretched to the card's width with `preserveAspectRatio="none"`,
 * which would smear the stroke along with it; `vector-effect` keeps the line a
 * constant weight. That is also why there is no end-point dot - a circle would
 * come out an ellipse - and why the day labels are HTML underneath rather than
 * SVG text.
 */

const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 64;
const TOP_PADDING = 4;

export interface SparklineProps {
  values: number[];
  /** Accessible summary. The chart is decorative without it. */
  caption: string;
  /** Start and end labels rendered under the line. */
  startLabel?: string;
  endLabel?: string;
  /** Unique per page when more than one sparkline is rendered. */
  gradientId?: string;
  labelClassName?: string;
}

export function Sparkline({
  values,
  caption,
  startLabel,
  endLabel,
  gradientId = "sparkline-fill",
  labelClassName = "text-slate-400",
}: SparklineProps) {
  const plotHeight = VIEW_HEIGHT - TOP_PADDING;

  // A flat run of zeros still deserves a baseline rather than a divide by zero,
  // and a single tall day should not squash the rest into the floor.
  const max = Math.max(...values, 0) || 1;
  const xs = bandCentres(values.length, VIEW_WIDTH);
  const points = values.map((value, index) => ({
    x: xs[index] ?? 0,
    y: scaleY(value, max, plotHeight, TOP_PADDING),
  }));

  const line = linePath(points);
  const area =
    points.length > 0
      ? `${line} L${VIEW_WIDTH} ${VIEW_HEIGHT} L0 ${VIEW_HEIGHT} Z`
      : "";

  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={caption}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-brand-500)"
              stopOpacity="0.28"
            />
            <stop
              offset="100%"
              stopColor="var(--color-brand-500)"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
        <path
          d={line}
          fill="none"
          stroke="var(--color-brand-600)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Marks where today sits, since today is the only partial day. */}
        <line
          x1={VIEW_WIDTH}
          y1={0}
          x2={VIEW_WIDTH}
          y2={VIEW_HEIGHT}
          stroke="var(--color-brand-600)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.45}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {startLabel || endLabel ? (
        <div className={`mt-1.5 flex justify-between text-[11px] ${labelClassName}`}>
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
