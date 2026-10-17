/** Linear scale and monotone curve for MetricOverlayChart. New geometry, not a Tandem port. */

export interface Pt {
  x: number;
  y: number;
}

export interface ChartSample {
  at: number;
  value: number | null;
}

export const BIN_COUNT = 16;
/** A gap also has to be at least this long, even when the median interval is short. */
export const MIN_GAP_MS = 15_000;

/** Map `domain` onto `range`. A zero-width domain sits at the middle of the range. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const slope = (r1 - r0) / span;
  return (value: number) => r0 + (value - d0) * slope;
}

/**
 * Top of a 0-based Y axis. Ratios use 0–100. Other units round the peak up
 * to a 1-2-5 step so the grid is readable. Empty or non-positive series use 1.
 */
export function chartMaximum(values: readonly (number | null)[], unit: string): number {
  if (unit === "ratio") return 100;
  let max = 0;
  for (const value of values) {
    if (value != null && Number.isFinite(value) && value > max) max = value;
  }
  if (max <= 0) return unit === "requests" ? 2 : 1;
  const raw = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 5, 10];
  let step = 10 * magnitude;
  for (const n of steps) {
    if (n * magnitude >= raw) {
      step = n * magnitude;
      break;
    }
  }
  if (unit === "requests") return Math.max(2, Math.ceil(max / 2) * 2);
  return Math.ceil(max / step) * step;
}

/** Ratio series are drawn as percent. Anything else stays a plain number. */
export function displayValue(value: number | null, unit: string): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return unit === "ratio" ? value * 100 : value;
}

/**
 * Upper median of the gaps between samples. One sample has no interval; the
 * caller then has nothing to split. Even counts use the upper of the two
 * middle gaps so a single long outage does not set the median by itself.
 */
export function medianIntervalMs(samples: readonly { at: number }[]): number {
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) intervals.push(samples[i].at - samples[i - 1].at);
  if (intervals.length === 0) return 3_000;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

/** True when this interval should break the line: longer than 3× the median, and at least 15s. */
export function opensGap(intervalMs: number, medianMs: number): boolean {
  return intervalMs >= MIN_GAP_MS && intervalMs > medianMs * 3;
}

/**
 * Screen points for one series. A null value, or a time gap, becomes a null
 * so the curve starts a new subpath instead of bridging the hole.
 */
export function plotPoints(
  samples: readonly ChartSample[],
  x: (at: number) => number,
  y: (value: number) => number,
  unit: string
): (Pt | null)[] {
  const median = medianIntervalMs(samples);
  const out: (Pt | null)[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (i > 0 && opensGap(sample.at - samples[i - 1].at, median)) out.push(null);
    const value = displayValue(sample.value, unit);
    out.push(value == null ? null : { x: x(sample.at), y: y(value) });
  }
  return out;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Smooth cubic through one run of points. Tangents follow Fritsch–Carlson:
 * zero where the slope changes sign, then clamped so a segment cannot overshoot
 * its endpoints. X must be strictly increasing.
 */
function monotoneRun(points: readonly Pt[]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${fmt(points[0].x)} ${fmt(points[0].y)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const span = points[i + 1].x - points[i].x;
    dx.push(span);
    slope.push(span === 0 ? 0 : (points[i + 1].y - points[i].y) / span);
  }

  const m = new Array<number>(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(slope[i]) < 1e-12) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const hypot = a * a + b * b;
    if (hypot > 9) {
      const t = 3 / Math.sqrt(hypot);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const span = dx[i];
    const x0 = points[i].x;
    const y0 = points[i].y;
    const x1 = points[i + 1].x;
    const y1 = points[i + 1].y;
    const c1x = x0 + span / 3;
    const c1y = y0 + (m[i] * span) / 3;
    const c2x = x1 - span / 3;
    const c2y = y1 - (m[i + 1] * span) / 3;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x1)} ${fmt(y1)}`;
  }
  return d;
}

/** One SVG path. Nulls, and any step backward in x, start a new subpath. */
export function monotonePath(points: readonly (Pt | null)[]): string {
  const parts: string[] = [];
  let run: Pt[] = [];
  const flush = () => {
    if (run.length > 0) parts.push(monotoneRun(run));
    run = [];
  };
  for (const point of points) {
    if (point == null || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      flush();
      continue;
    }
    if (run.length > 0 && point.x <= run[run.length - 1].x) flush();
    run.push(point);
  }
  flush();
  return parts.join(" ");
}

export function sampleMean(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value != null && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

export interface Histogram16 {
  binCount: number;
  binStart: number;
  binEnd: number;
  binWidth: number;
  counts: number[];
  mean: number | null;
  /** Bin that contains the mean, or -1 when there is nothing to highlight. */
  meanBin: number;
}

/**
 * Sixteen equal bins across the observed range. A flat series spreads a little
 * around that value (and stays inside 0–100 for ratios) so the mean still
 * lands in a real bin.
 */
export function histogram16(values: readonly number[], unit = ""): Histogram16 {
  const observed = values.filter((value) => Number.isFinite(value));
  const minValue = observed.length ? Math.min(...observed) : 0;
  const maxValue = observed.length ? Math.max(...observed) : 0;
  const range = maxValue - minValue || Math.abs(maxValue) * 0.1 || 1;
  const flat = maxValue === minValue;
  const binStart = flat ? (minValue >= 0 ? Math.max(0, minValue - range / 2) : minValue - range / 2) : minValue;
  const rawEnd = binStart + range;
  const binEnd = flat && unit === "ratio" && maxValue <= 100 ? Math.min(100, rawEnd) : flat ? rawEnd : maxValue;
  const binWidth = binEnd > binStart ? (binEnd - binStart) / BIN_COUNT : 1;
  const counts = Array.from({ length: BIN_COUNT }, () => 0);
  for (const value of observed) {
    const index = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((value - binStart) / binWidth)));
    counts[index] += 1;
  }
  const mean = sampleMean(observed);
  const meanBin =
    mean == null ? -1 : Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((mean - binStart) / binWidth)));
  return { binCount: BIN_COUNT, binStart, binEnd, binWidth, counts, mean, meanBin };
}

/** Samples inside [end - window, end], inclusive. */
export function windowSamples(samples: readonly ChartSample[], end: number, windowSeconds: number): ChartSample[] {
  const start = end - windowSeconds * 1000;
  return samples.filter((sample) => sample.at >= start && sample.at <= end);
}

export function appendChartSample(history: readonly ChartSample[], sample: ChartSample, maxSamples = 600, maxWindowMs = 30 * 60 * 1000): ChartSample[] {
  if (!Number.isFinite(sample.at)) return history.slice();
  if (history.length > 0 && history[history.length - 1].at >= sample.at) return history.slice();
  const next = history.filter((row) => row.at >= sample.at - maxWindowMs);
  next.push(sample);
  return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}
