import { html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChartElement, linear, monotonePath, type Pt } from "./chartBase";

export interface ChartSample {
  at: number;
  value: number | null;
}

export const BIN_COUNT = 16;
const MIN_GAP_MS = 15_000;

export type ChartMode = "trend" | "histogram" | "overlay";

export function chartValue(value: number | null, unit: string): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return unit === "ratio" ? value * 100 : value;
}

/** Upper median of the sample spacing. No intervals yet means the usual 3s poll. */
export function medianGapMs(samples: readonly { at: number }[]): number {
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) intervals.push(samples[i].at - samples[i - 1].at);
  if (intervals.length === 0) return 3_000;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

/**
 * Break the line when this interval is longer than 15s and longer than three
 * times the median spacing. A steady slow poll stays one curve.
 */
export function gapLimitMs(samples: readonly { at: number }[]): number {
  return Math.max(MIN_GAP_MS, medianGapMs(samples) * 3);
}

export function insertTimeGaps(samples: readonly { at: number }[], points: readonly (Pt | null)[]): (Pt | null)[] {
  const limit = gapLimitMs(samples);
  const gapped: (Pt | null)[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && samples[i].at - samples[i - 1].at > limit) gapped.push(null);
    gapped.push(points[i] ?? null);
  }
  return gapped;
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

export interface GenerationSpan {
  /** First content-token time. Same clock as sample `at` and `endAt`. */
  firstTokenAt?: number | null;
  /** Response end, or now while the reply is still streaming. */
  endAt?: number | null;
  /** Polled generation samples. Zeros and samples outside the span are dropped. */
  samples?: readonly { at: number; value: number | null }[];
}

/**
 * Non-zero generation samples from the first content token through the end of
 * the reply. While streaming, `endAt` is now. Idle zeros never enter this set.
 */
export function generationSpanSamples(span: GenerationSpan): { at: number; value: number }[] {
  const first = span.firstTokenAt;
  const end = span.endAt;
  if (typeof first !== "number" || typeof end !== "number") return [];
  if (!Number.isFinite(first) || !Number.isFinite(end) || !(end >= first)) return [];
  const kept: { at: number; value: number }[] = [];
  for (const sample of span.samples ?? []) {
    if (sample.at < first || sample.at > end) continue;
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value) || sample.value === 0) continue;
    kept.push({ at: sample.at, value: sample.value });
  }
  return kept;
}

/** Arithmetic mean of the non-zero samples in the generation span. */
export function generationSpanMean(span: GenerationSpan): number | null {
  return sampleMean(generationSpanSamples(span).map((sample) => sample.value));
}

/** Top of a zero-based axis. Ratios use 0–100. Other units round up to a 1-2-5 step. */
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

export interface Histogram16 {
  binCount: number;
  binStart: number;
  binEnd: number;
  binWidth: number;
  counts: number[];
  mean: number | null;
  /** Bin that holds the mean, or -1 when there is nothing to highlight. */
  meanBin: number;
}

/**
 * Sixteen equal bins across the observed range. A flat series spreads a little
 * around that value, and a ratio stays inside 0–100, so the mean still lands
 * in a real bin. The mean is the arithmetic mean of these values.
 */
export function histogram16(values: readonly number[], unit = ""): Histogram16 {
  const observed = values.filter((value) => Number.isFinite(value));
  const minValue = observed.length ? Math.min(...observed) : 0;
  const maxValue = observed.length ? Math.max(...observed) : 0;
  const spread = maxValue - minValue || Math.abs(maxValue) * 0.1 || 1;
  const flat = maxValue === minValue;
  const binStart = flat ? Math.max(minValue >= 0 ? 0 : -Infinity, minValue - spread / 2) : minValue;
  const uncapped = binStart + spread;
  const binEnd = flat ? Math.min(unit === "ratio" && maxValue <= 100 ? 100 : Infinity, uncapped) : maxValue;
  const binWidth = binEnd > binStart ? (binEnd - binStart) / BIN_COUNT : 1;
  const counts = Array.from({ length: BIN_COUNT }, () => 0);
  for (const value of observed) {
    const index = Math.min(BIN_COUNT - 1, Math.floor((value - binStart) / binWidth));
    if (index >= 0) counts[index] += 1;
  }
  const mean = sampleMean(observed);
  const meanBin = mean == null ? -1 : Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((mean - binStart) / binWidth)));
  return { binCount: BIN_COUNT, binStart, binEnd, binWidth, counts, mean, meanBin };
}

function compactTick(value: number): string {
  return value.toLocaleString(undefined, { notation: "compact", maximumSignificantDigits: 3 });
}

function binTick(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

function clock(at: number, windowSeconds: number, width: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(windowSeconds <= 300 && width >= 220 ? { second: "2-digit" } : {}),
  });
}

function seriesStroke(color: string): string {
  return color === "orange" ? "var(--series-orange)" : "var(--series-cobalt)";
}

@customElement("spark-metric-chart")
export class MetricChart extends ChartElement {
  @property({ attribute: false }) declare samples: ChartSample[];
  @property({ type: Number }) declare end: number;
  @property({ type: Number }) declare windowSeconds: number;
  @property({ type: String }) declare unit: string;
  @property({ type: String }) declare label: string;
  @property({ type: String }) declare color: string;
  @property({ type: String }) declare mode: ChartMode;
  @property({ type: Boolean }) declare excludeZeros: boolean;
  /**
   * Samples for the histogram, dashed mean, highlighted bin, and sample count.
   * Null keeps the time-window samples. The orange line always uses `samples`.
   */
  @property({ attribute: false }) declare histogramSamples: ChartSample[] | null;
  @state() private declare hover: number | null;

  constructor() {
    super();
    this.samples = [];
    this.end = 0;
    this.windowSeconds = 300;
    this.unit = "";
    this.label = "";
    this.color = "cobalt";
    this.mode = "trend";
    this.excludeZeros = false;
    this.histogramSamples = null;
    this.hover = null;
  }

  private readonly onPoint = (event: MouseEvent | TouchEvent) => {
    if (!this.samples.length) return;
    const clientX = "touches" in event ? event.touches[0]?.clientX : event.clientX;
    if (clientX == null) return;
    const rect = this.getBoundingClientRect();
    const plot = rect.width - 42 - (this.mode === "overlay" ? 52 : 10);
    const t = plot === 0 ? 0 : (clientX - rect.left - 42) / plot;
    const time = this.end - this.windowSeconds * 1000 + Math.max(0, Math.min(1, t)) * this.windowSeconds * 1000;
    let best = 0;
    for (let i = 1; i < this.samples.length; i++) {
      if (Math.abs(this.samples[i].at - time) < Math.abs(this.samples[best].at - time)) best = i;
    }
    this.hover = best;
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.samples.length) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End" && event.key !== "Escape") return;
    event.preventDefault();
    if (event.key === "Escape") {
      this.hover = null;
      return;
    }
    if (event.key === "Home") {
      this.hover = 0;
      return;
    }
    if (event.key === "End") {
      this.hover = this.samples.length - 1;
      return;
    }
    const current = this.hover ?? this.samples.length - 1;
    const step = event.key === "ArrowLeft" ? -1 : 1;
    this.hover = Math.max(0, Math.min(this.samples.length - 1, current + step));
  };

  override render() {
    const distribution = this.mode !== "trend";
    const isTrend = this.mode !== "histogram";
    const width = this.width || 260;
    const height = distribution ? 140 : 128;
    const left = 42;
    const right = width - (distribution ? 52 : 10);
    const top = this.mode === "overlay" ? 26 : 8;
    const bottom = distribution ? 116 : 102;
    const start = this.end - this.windowSeconds * 1000;
    const values = this.samples.map((sample) => chartValue(sample.value, this.unit));
    const histogramRows = this.histogramSamples ?? this.samples;
    const histogramValues = histogramRows.map((sample) => chartValue(sample.value, this.unit));
    const observed = histogramValues.filter((value): value is number => value != null && (!this.excludeZeros || value !== 0));
    const max = chartMaximum(values, this.unit);
    const x = linear([start, this.end], [left, right]);
    const y = linear([0, max], [bottom, top]);
    const points: (Pt | null)[] = this.samples.map((sample, index) => {
      const value = values[index];
      return value == null ? null : { x: x(sample.at), y: y(value) };
    });
    const gapped = insertTimeGaps(this.samples, points);
    const displayUnit = this.unit === "ratio" ? "%" : this.unit;
    const yTicks = this.mode === "overlay" ? [0, max / 4, max / 2, (3 * max) / 4, max] : [0, max / 2, max];
    const active = this.hover == null ? undefined : this.samples[this.hover];
    const activeValue = active ? chartValue(active.value, this.unit) : null;
    const latest = points[points.length - 1];
    const bins = histogram16(observed, this.unit);
    const countMax = Math.max(1, ...bins.counts);
    const histY = linear([0, countMax], [bottom, top]);
    const histX = linear([bins.binStart, bins.binEnd], [left, right]);
    const countTicks = [...new Set([0, Math.ceil(countMax / 2), countMax])];
    const plotWidth = right - left;
    const binTickCount = plotWidth >= 240 ? 4 : plotWidth >= 120 ? 2 : 1;
    const meanText = bins.mean == null ? "" : `, mean ${binTick(bins.mean)} ${displayUnit} highlighted`;
    const distributionLabel = `${bins.binCount} vertical bins, metric values (${displayUnit}) on the bottom axis and samples per bin on the right axis, ${observed.length} samples${this.excludeZeros ? ", excluding zero samples" : ""}${meanText}`;
    const minutes = this.windowSeconds / 60;
    const aria = this.mode === "histogram"
      ? `${this.label} distribution histogram: ${distributionLabel}, last ${minutes} minutes`
      : `${this.label}: Y scale 0 to ${compactTick(max)} ${displayUnit}, last ${minutes} minutes${this.mode === "overlay" ? `, time on the top axis, with ${distributionLabel}` : ""}`;

    return html`<div class="metric-chart ${distribution ? "distribution-view" : ""} ${this.mode === "histogram" ? "histogram-view" : ""} ${this.mode === "overlay" ? "overlay-view" : ""}" role="img" tabindex=${isTrend ? "0" : "-1"} aria-label=${aria} @mousemove=${isTrend ? this.onPoint : nothing} @touchstart=${isTrend ? this.onPoint : nothing} @touchmove=${isTrend ? this.onPoint : nothing} @mouseleave=${() => { this.hover = null; }} @keydown=${isTrend ? this.onKey : nothing}>
      <svg width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`}>
        ${isTrend ? svg`
          ${yTicks.map((value) => svg`<line class="chart-grid" x1=${left} x2=${right} y1=${y(value)} y2=${y(value)} /><text class="chart-y-label" x=${left - 7} y=${y(value) + 3} text-anchor="end">${compactTick(value)}${this.unit === "ratio" ? "%" : ""}</text>`)}
          <line class="chart-axis" x1=${left} x2=${left} y1=${top} y2=${bottom}/>
          ${[start, this.end].map((at, index) => svg`<text class="chart-time-label" x=${x(at)} y=${this.mode === "overlay" ? 16 : height - 6} text-anchor=${index ? "end" : "start"}>${clock(at, this.windowSeconds, width)}</text>`)}
          ${this.mode === "overlay" && plotWidth >= 200 ? svg`<text class="chart-axis-title" x=${(left + right) / 2} y="16" text-anchor="middle">Time</text>` : nothing}
          ${this.mode === "overlay" ? svg`<line class="chart-axis" x1=${left} x2=${right} y1=${top} y2=${top}/>` : nothing}
        ` : nothing}
        ${distribution ? svg`
          ${this.mode === "histogram" ? countTicks.map((value) => svg`<line class="chart-grid" x1=${left} x2=${right} y1=${histY(value)} y2=${histY(value)}/>`) : nothing}
          <line class="chart-axis" x1=${right} x2=${right} y1=${top} y2=${bottom}/>
          ${bins.meanBin < 0 ? nothing : svg`<rect class="histogram-mean-bin" x=${histX(bins.binStart + bins.meanBin * bins.binWidth)} y=${top} width=${histX(bins.binStart + (bins.meanBin + 1) * bins.binWidth) - histX(bins.binStart + bins.meanBin * bins.binWidth)} height=${bottom - top}><title>Bin containing mean ${binTick(bins.mean!)} ${displayUnit}</title></rect>`}
          ${bins.counts.map((count, index) => {
            const value0 = bins.binStart + index * bins.binWidth;
            const value1 = value0 + bins.binWidth;
            const x0 = histX(value0);
            const x1 = histX(value1);
            const holdsMean = index === bins.meanBin;
            return svg`<rect class="histogram-bar ${this.mode === "overlay" ? "overlay-bar" : ""} ${holdsMean ? "mean-bin" : ""}" x=${x0 + 1} y=${histY(count)} width=${Math.max(0, x1 - x0 - 2)} height=${Math.max(0, bottom - histY(count))} rx="1"><title>${binTick(value0)}–${binTick(value1)} ${displayUnit}: ${count} samples${holdsMean ? `; contains mean ${binTick(bins.mean!)} ${displayUnit}` : ""}</title></rect>`;
          })}
          ${countTicks.map((value) => svg`<line class="chart-axis" x1=${right} x2=${right + 3} y1=${histY(value)} y2=${histY(value)}/><text class="chart-y-label histogram-count-label" x=${right + 6} y=${histY(value) + 3} text-anchor="start">${value}</text>`)}
          <text class="chart-axis-title" transform=${`translate(${width - 6} ${(top + bottom) / 2}) rotate(-90)`} text-anchor="middle">Samples / bin</text>
          ${observed.length ? Array.from({ length: binTickCount + 1 }, (_, index) => {
            const value = bins.binStart + (bins.binEnd - bins.binStart) * index / binTickCount;
            return svg`<line class="chart-axis" x1=${histX(value)} x2=${histX(value)} y1=${bottom} y2=${bottom + 4}/><text class="chart-bin-label" x=${histX(value)} y=${bottom + 16} text-anchor=${index === 0 ? "start" : index === binTickCount ? "end" : "middle"}>${binTick(value)}</text>`;
          }) : svg`<text class="chart-bin-label" x=${(left + right) / 2} y=${bottom + 16} text-anchor="middle">${this.excludeZeros ? "No nonzero samples" : "No samples"}</text>`}
          ${bins.mean == null ? nothing : svg`<line class="histogram-mean-line" x1=${histX(bins.mean)} x2=${histX(bins.mean)} y1=${top} y2=${bottom}><title>Mean: ${binTick(bins.mean)} ${displayUnit}</title></line>`}
        ` : nothing}
        <line class="chart-axis" x1=${left} x2=${right} y1=${bottom} y2=${bottom}/>
        ${isTrend ? svg`
          ${values.some((value) => value != null) ? svg`<path d=${monotonePath(gapped)} fill="none" stroke=${seriesStroke(this.color)} stroke-width="1.7"/>` : nothing}
          ${latest ? svg`<circle cx=${latest.x} cy=${latest.y} r="2.5" fill="var(--orange-hi)"/>` : nothing}
          ${active ? svg`<line class="crosshair" x1=${x(active.at)} x2=${x(active.at)} y1=${top} y2=${bottom}/>` : nothing}
        ` : nothing}
      </svg>
      ${isTrend && active ? html`<div class="chart-tooltip" role="status">${activeValue == null ? "Unavailable" : `${compactTick(activeValue)} ${displayUnit}`} · ${clock(active.at, this.windowSeconds, width)}</div>` : nothing}
    </div>`;
  }
}
