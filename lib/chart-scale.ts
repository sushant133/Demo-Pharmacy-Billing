/**
 * Chart scale helpers.
 *
 * Pure, so axis maths - the part that silently misleads when it is wrong - can
 * be tested. Nothing here knows about SVG or React.
 */

/**
 * A "nice" axis maximum and its tick values.
 *
 * Ticks land on 1 / 2 / 2.5 / 5 x a power of ten, which is what makes an axis
 * read as 0 / 500 / 1,000 rather than 0 / 437 / 874. The domain always starts
 * at zero: for bars and for money over time, a truncated baseline exaggerates
 * differences, which is the single most common way a chart lies.
 */
export function niceScale(
  maxValue: number,
  targetTicks = 4,
): { max: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1] };
  }

  const rawStep = maxValue / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;

  const niceMultiplier =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;

  const step = niceMultiplier * magnitude;
  const max = Math.ceil(maxValue / step) * step;

  const ticks: number[] = [];
  // Accumulate with a rounding guard so 0.1-style steps don't drift.
  for (let i = 0; i * step <= max + step / 1000; i++) {
    ticks.push(Math.round(i * step * 1e6) / 1e6);
  }

  return { max, ticks };
}

/** Map a value in [0, max] onto a pixel span, measured from the baseline. */
export function scaleY(
  value: number,
  max: number,
  plotHeight: number,
  topPadding = 0,
): number {
  if (max <= 0) return topPadding + plotHeight;
  const clamped = Math.max(0, Math.min(value, max));
  return topPadding + plotHeight - (clamped / max) * plotHeight;
}

/** Evenly spaced x positions, one per point, inset half a step at each end. */
export function bandCentres(count: number, width: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [width / 2];
  const step = width / (count - 1);
  return Array.from({ length: count }, (_, i) => i * step);
}

/**
 * Which x-axis labels to render.
 *
 * Rather than rotating or shrinking text, drop labels until they fit: always
 * keep the first and last, then thin the middle evenly. A clipped or
 * overlapping axis is worse than a sparse one.
 */
export function thinLabels(count: number, maxLabels: number): boolean[] {
  const keep = new Array<boolean>(count).fill(false);
  if (count === 0) return keep;
  if (count <= maxLabels) return keep.fill(true);

  const stride = Math.ceil(count / maxLabels);
  for (let i = 0; i < count; i += stride) keep[i] = true;

  // The last point carries the direct label, so it must always be named.
  keep[count - 1] = true;

  // Drop the penultimate kept label if the final one would crowd it.
  const secondLast = count - 1 - stride;
  if (secondLast > 0 && count - 1 - secondLast < stride / 2) {
    keep[secondLast] = false;
  }

  return keep;
}

/** Compact money for axis ticks: 1200 -> "1.2k", 1500000 -> "1.5M". */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(value / 1_000)}k`;
  return trimZero(value);
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** SVG path for a polyline through points. Empty string for no points. */
export function linePath(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`)
    .join(" ");
}

/**
 * Horizontal bar path with only the data end rounded.
 *
 * The baseline end stays square so every bar visibly starts from the same
 * line; rounding both ends detaches it from the axis.
 */
export function horizontalBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 4,
): string {
  const r = Math.max(0, Math.min(radius, width, height / 2));
  if (r === 0 || width <= 0) {
    return `M${round(x)} ${round(y)} h${round(width)} v${round(height)} h${round(-width)} Z`;
  }
  return [
    `M${round(x)} ${round(y)}`,
    `h${round(width - r)}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `v${round(height - 2 * r)}`,
    `a${r} ${r} 0 0 1 ${-r} ${r}`,
    `h${round(-(width - r))}`,
    "Z",
  ].join(" ");
}

/**
 * Vertical bar with only the top corners rounded, so every column still
 * sits on the same baseline.
 */
export function verticalBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 3,
): string {
  if (width <= 0 || height <= 0) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height));
  if (r === 0) {
    return `M${round(x)} ${round(y)} h${round(width)} v${round(height)} h${round(-width)} Z`;
  }
  return [
    `M${round(x)} ${round(y + r)}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}`,
    `h${round(width - 2 * r)}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `v${round(height - r)}`,
    `h${round(-width)}`,
    "Z",
  ].join(" ");
}

/** Point on a circle. Angle 0 is 12 o'clock, clockwise. */
export function polar(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: round(cx + radius * Math.cos(rad)),
    y: round(cy + radius * Math.sin(rad)),
  };
}

/**
 * Donut slice from `startAngle` to `endAngle` in degrees, clockwise from 12 o'clock.
 * A full ring (sweep >= 359.999) is drawn as two semicircles so SVG can close it.
 */
export function donutSlicePath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  if (sweep <= 0 || outer <= inner) return "";

  if (sweep >= 359.999) {
    return [
      `M${round(cx)} ${round(cy - outer)}`,
      `A${outer} ${outer} 0 1 1 ${round(cx)} ${round(cy + outer)}`,
      `A${outer} ${outer} 0 1 1 ${round(cx)} ${round(cy - outer)}`,
      `M${round(cx)} ${round(cy - inner)}`,
      `A${inner} ${inner} 0 1 0 ${round(cx)} ${round(cy + inner)}`,
      `A${inner} ${inner} 0 1 0 ${round(cx)} ${round(cy - inner)}`,
      "Z",
    ].join(" ");
  }

  const large = sweep > 180 ? 1 : 0;
  const p1 = polar(cx, cy, outer, startAngle);
  const p2 = polar(cx, cy, outer, endAngle);
  const p3 = polar(cx, cy, inner, endAngle);
  const p4 = polar(cx, cy, inner, startAngle);
  return [
    `M${p1.x} ${p1.y}`,
    `A${outer} ${outer} 0 ${large} 1 ${p2.x} ${p2.y}`,
    `L${p3.x} ${p3.y}`,
    `A${inner} ${inner} 0 ${large} 0 ${p4.x} ${p4.y}`,
    "Z",
  ].join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
