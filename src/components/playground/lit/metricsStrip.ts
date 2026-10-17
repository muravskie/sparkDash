import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LightElement } from "./base";
import { generationSpanSamples, sampleMean, type ChartSample } from "./metricChart";
import "./metricChart";

/** Probe fields the strip knows how to plot. Missing fields stay null. */
export interface EngineProbe {
  generationTps?: number | null;
  prefillTps?: number | null;
  ttftSeconds?: number | null;
}

export interface ProbeRow {
  at: number;
  generation: number | null;
  prefill: number | null;
  ttft: number | null;
}

const WINDOWS = [60, 300, 900, 1800] as const;
const MAX_WINDOW_MS = 30 * 60 * 1000;
const MAX_SAMPLES = 600;
const EMPTY: ProbeRow[] = [];

type SeriesKey = "generation" | "prefill" | "ttft";

const SERIES: { key: SeriesKey; title: string; unit: string; excludeZeros: boolean }[] = [
  { key: "generation", title: "Generation throughput", unit: "tokens/s", excludeZeros: false },
  { key: "prefill", title: "Prompt throughput", unit: "tokens/s", excludeZeros: true },
  { key: "ttft", title: "Mean time to first token", unit: "seconds", excludeZeros: false },
];

const rings = new Map<string, { source: object | null; samples: ProbeRow[] }>();

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resetProbeRings(): void {
  rings.clear();
}

export function readProbeRing(key: string): ProbeRow[] {
  return rings.get(key)?.samples ?? EMPTY;
}

/** Append one poll. The same probe object is ignored, and a null reading is a gap, not a zero. */
export function recordProbeRing(key: string, source: object, at: number, probe: EngineProbe): ProbeRow[] {
  const prev = rings.get(key);
  if (prev && prev.source === source) return prev.samples;
  if (!Number.isFinite(at)) return prev?.samples ?? EMPTY;
  const history = prev?.samples ?? EMPTY;
  if (history.length > 0 && history[history.length - 1].at >= at) return history;
  const row: ProbeRow = {
    at,
    generation: finite(probe.generationTps),
    prefill: finite(probe.prefillTps),
    ttft: finite(probe.ttftSeconds),
  };
  const samples = [...history.filter((sample) => sample.at >= at - MAX_WINDOW_MS), row].slice(-MAX_SAMPLES);
  rings.set(key, { source, samples });
  return samples;
}

export function ringHasValue(rows: readonly ProbeRow[], key: SeriesKey): boolean {
  return rows.some((row) => row[key] != null && Number.isFinite(row[key]));
}

/** Tok/s on this strip always has one digit after the decimal. Seconds stay at 3. */
export function formatMetric(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const shown = unit === "ratio" ? value * 100 : value;
  const digits = unit === "seconds" ? 3 : 1;
  return shown.toLocaleString(undefined, {
    minimumFractionDigits: digits === 1 ? 1 : 0,
    maximumFractionDigits: digits,
  });
}

function formatUnit(unit: string): string {
  if (unit === "ratio") return "%";
  if (unit === "seconds") return "s";
  return unit;
}

function windowRows(rows: readonly ProbeRow[], end: number, seconds: number): ProbeRow[] {
  const start = end - seconds * 1000;
  return rows.filter((row) => row.at >= start && row.at <= end);
}

function nowValue(probe: EngineProbe | null, key: SeriesKey): number | null {
  if (!probe) return null;
  if (key === "generation") return finite(probe.generationTps);
  if (key === "prefill") return finite(probe.prefillTps);
  return finite(probe.ttftSeconds);
}

export interface GenerationSpanBounds {
  firstAt: number;
  /** Null while the reply is still streaming: samples run through the latest poll. */
  endAt: number | null;
}

function latestNonZero(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value != null && Number.isFinite(value) && value !== 0) return value;
  }
  return null;
}

@customElement("spark-metrics")
export class MetricsStrip extends LightElement {
  @property({ attribute: false }) declare rows: ProbeRow[];
  @property({ attribute: false }) declare now: EngineProbe | null;
  @property({ type: Number }) declare windowSeconds: number;
  @property({ type: Number }) declare sampledAt: number;
  /**
   * Current or last reply. Null before its first content token. `endAt` null
   * means the reply is still streaming.
   */
  @property({ attribute: false }) declare generationSpan: GenerationSpanBounds | null;

  constructor() {
    super();
    this.rows = [];
    this.now = null;
    this.windowSeconds = 300;
    this.sampledAt = 0;
    this.generationSpan = null;
  }

  private changeWindow(event: Event) {
    const seconds = Number((event.target as HTMLSelectElement).value);
    this.dispatchEvent(new CustomEvent("window-change", { detail: seconds, bubbles: true }));
  }

  override render() {
    const history = windowRows(this.rows, this.sampledAt, this.windowSeconds);
    // While the reply is still streaming, endAt is null. The last stored poll can
    // still be older than the first token, and that must not discard the span.
    const spanEnd = this.generationSpan == null
      ? null
      : (this.generationSpan.endAt ?? Math.max(this.sampledAt, this.generationSpan.firstAt, Date.now()));
    const generationSamples = generationSpanSamples({
      firstTokenAt: this.generationSpan?.firstAt ?? null,
      endAt: spanEnd,
      samples: this.rows.map((row) => ({ at: row.at, value: row.generation })),
    });
    const generationMean = sampleMean(generationSamples.map((sample) => sample.value));
    const liveGeneration = nowValue(this.now, "generation");
    const generationNow = liveGeneration != null && liveGeneration !== 0
      ? liveGeneration
      : latestNonZero(this.rows.map((row) => row.generation));
    const visible = SERIES.filter((series) => series.key !== "ttft" || ringHasValue(this.rows, "ttft") || nowValue(this.now, "ttft") != null);
    return html`<div class="section-heading"><h2>Live engine performance</h2><div class="metric-view-controls"><label class="window-picker">Time window<select aria-label="Playground time window" @change=${this.changeWindow}>${WINDOWS.map((seconds) => html`<option value=${seconds} .selected=${seconds === this.windowSeconds}>${seconds / 60} min</option>`)}</select></label></div></div>
      <div class="metric-grid compact-metrics">${visible.map((series, index) => {
        const samples: ChartSample[] = history.map((row) => ({ at: row.at, value: row[series.key] }));
        const generation = series.key === "generation";
        const mean = generation
          ? generationMean
          : sampleMean(samples.filter((sample) => !series.excludeZeros || sample.value !== 0).map((sample) => sample.value));
        const live = generation ? generationNow : nowValue(this.now, series.key);
        const current = live != null ? live : latestNonZero(this.rows.map((row) => row[series.key]));
        const meanTitle = generation
          ? "Arithmetic mean of non-zero generation samples from the first content token through the end of the reply"
          : `Mean of ${series.excludeZeros ? "nonzero" : "available"} samples in the selected ${this.windowSeconds / 60}-minute window`;
        return html`<article class="metric-card ${index < 2 ? "featured" : ""}">
          <div class="metric-label">${series.title}${series.excludeZeros ? html` <span class="metric-title-note">(non-zero samples only)</span>` : nothing}</div>
          <div class="metric-readings">
            <div class="metric-number"><strong>${formatMetric(current, series.unit)}</strong><span>${formatUnit(series.unit)} now</span></div>
            <div class="metric-mean" title=${meanTitle}><div class="metric-number"><strong>${formatMetric(mean, series.unit)}</strong><span>${formatUnit(series.unit)}</span></div><div class="metric-label">Mean</div></div>
          </div>
          <spark-metric-chart .samples=${samples} .end=${this.sampledAt} .windowSeconds=${this.windowSeconds} .unit=${series.unit} .label=${series.title} mode="overlay" .excludeZeros=${series.excludeZeros} .histogramSamples=${generation ? generationSamples : null} color=${index === 0 ? "orange" : "cobalt"}></spark-metric-chart>
        </article>`;
      })}</div>`;
  }
}
