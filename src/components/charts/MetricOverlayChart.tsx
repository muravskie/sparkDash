import { useMemo, useState, type KeyboardEvent, type MouseEvent, type TouchEvent } from "react";
import type { LlmMetrics } from "../../api/types";
import { useElementWidth } from "../ui/useElementWidth";
import "../../styles/charts.css";
import {
  chartMaximum,
  displayValue,
  histogram16,
  linearScale,
  monotonePath,
  plotPoints,
  windowSamples,
  type ChartSample,
  type Pt,
} from "./chartGeometry";
import { CHART_WINDOW_SECONDS, seriesHasValues, useLlmChartRings } from "./llmChartBuffer";

export type ChartMode = "trend" | "histogram" | "overlay";

export interface MetricOverlayChartProps {
  samples: readonly ChartSample[];
  /** Right edge of the window, epoch ms. Defaults to the newest sample. */
  end?: number;
  windowSeconds?: number;
  /** "ratio" draws values as percent. Any other string is a plain unit. */
  unit?: string;
  label?: string;
  color?: string;
  mode?: ChartMode;
  excludeZeros?: boolean;
}

const LEFT = 42;
const RIGHT_DISTRIBUTION = 52;
const RIGHT_TREND = 10;

interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function frameFor(width: number, mode: ChartMode): Frame {
  const distribution = mode !== "trend";
  return {
    width,
    height: distribution ? 140 : 128,
    left: LEFT,
    right: width - (distribution ? RIGHT_DISTRIBUTION : RIGHT_TREND),
    top: mode === "overlay" ? 26 : 8,
    bottom: distribution ? 116 : 102,
  };
}

function formatTick(value: number): string {
  return value.toLocaleString(undefined, { notation: "compact", maximumSignificantDigits: 3 });
}

function formatBin(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

function formatTime(at: number, windowSeconds: number, width: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(windowSeconds <= 300 && width >= 220 ? { second: "2-digit" } : {}),
  });
}

function nearestIndex(samples: readonly ChartSample[], time: number): number {
  let best = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].at - time) < Math.abs(samples[best].at - time)) best = i;
  }
  return best;
}

function pointRuns(points: readonly (Pt | null)[]): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length) runs.push(cur);
    cur = [];
  };
  for (const point of points) {
    if (point == null) flush();
    else {
      if (cur.length && point.x <= cur[cur.length - 1].x) flush();
      cur.push(point);
    }
  }
  flush();
  return runs;
}

export function MetricOverlayChart({
  samples,
  end,
  windowSeconds = CHART_WINDOW_SECONDS,
  unit = "",
  label = "",
  color = "var(--color-accent)",
  mode = "overlay",
  excludeZeros = false,
}: MetricOverlayChartProps) {
  const distribution = mode !== "trend";
  const isTrend = mode !== "histogram";
  const [plotRef, width] = useElementWidth(320);
  const [hover, setHover] = useState<number | null>(null);
  const frame = frameFor(Math.max(160, width), mode);
  const endAt = end ?? samples[samples.length - 1]?.at ?? 0;
  const visible = useMemo(
    () => windowSamples(samples, endAt, windowSeconds),
    [samples, endAt, windowSeconds]
  );

  const model = useMemo(() => {
    const scaled = visible.map((sample) => displayValue(sample.value, unit));
    const observed = scaled.filter((value): value is number => value != null && (!excludeZeros || value !== 0));
    const max = chartMaximum(scaled, unit);
    const x = linearScale([endAt - windowSeconds * 1000, endAt], [frame.left, frame.right]);
    const y = linearScale([0, max], [frame.bottom, frame.top]);
    const points = plotPoints(visible, x, y, unit);
    const bins = histogram16(observed, unit);
    const countMax = Math.max(1, ...bins.counts);
    const histY = linearScale([0, countMax], [frame.bottom, frame.top]);
    const histX = linearScale([bins.binStart, bins.binEnd], [frame.left, frame.right]);
    const displayUnit = unit === "ratio" ? "%" : unit;
    return { scaled, observed, max, x, y, points, path: monotonePath(points), bins, countMax, histY, histX, displayUnit };
  }, [visible, unit, excludeZeros, endAt, windowSeconds, frame.left, frame.right, frame.top, frame.bottom]);

  const active = hover == null ? undefined : visible[hover];
  const activeValue = active ? displayValue(active.value, unit) : null;
  const minutes = windowSeconds / 60;
  const aria = distribution
    ? `${label || "Metric"}: Y scale 0 to ${formatTick(model.max)} ${model.displayUnit}, last ${minutes} minutes, time on the top axis, 16 bins${model.bins.mean == null ? "" : `, mean ${formatBin(model.bins.mean)} ${model.displayUnit} highlighted`}`
    : `${label || "Metric"}: Y scale 0 to ${formatTick(model.max)} ${model.displayUnit}, last ${minutes} minutes`;

  const moveTo = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || visible.length === 0) return;
    const inner = rect.width - LEFT - (distribution ? RIGHT_DISTRIBUTION : RIGHT_TREND);
    const t = inner <= 0 ? 0 : Math.max(0, Math.min(1, (clientX - rect.left - LEFT) / inner));
    const time = endAt - windowSeconds * 1000 + t * windowSeconds * 1000;
    setHover(nearestIndex(visible, time));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isTrend || visible.length === 0) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setHover(null);
      return;
    }
    if (event.key === "Home") {
      setHover(0);
      return;
    }
    if (event.key === "End") {
      setHover(visible.length - 1);
      return;
    }
    const base = hover ?? visible.length - 1;
    const next = base + (event.key === "ArrowLeft" ? -1 : 1);
    setHover(Math.max(0, Math.min(visible.length - 1, next)));
  };

  const onMouse = (event: MouseEvent<HTMLDivElement>) => {
    if (isTrend) moveTo(event.clientX);
  };
  const onTouch = (event: TouchEvent<HTMLDivElement>) => {
    const clientX = event.touches[0]?.clientX;
    if (isTrend && clientX != null) moveTo(clientX);
  };

  const yTicks = mode === "overlay" ? [0, model.max / 4, model.max / 2, (3 * model.max) / 4, model.max] : [0, model.max / 2, model.max];
  const countTicks = [...new Set([0, Math.ceil(model.countMax / 2), model.countMax])];
  const plotWidth = frame.right - frame.left;
  const binTickCount = plotWidth >= 240 ? 4 : plotWidth >= 120 ? 2 : 1;
  const start = endAt - windowSeconds * 1000;
  const lastPoint = model.points[model.points.length - 1];
  const runs = pointRuns(model.points);
  const mean = model.bins.mean;
  const meanBin = model.bins.meanBin;

  return (
    <div className="metric-overlay" style={{ ["--series" as string]: color }}>
      {label ? (
        <div className="metric-overlay__name">
          <span>{label}</span>
          {model.displayUnit ? <span className="metric-overlay__unit">{model.displayUnit}</span> : null}
        </div>
      ) : null}
      <div
        ref={plotRef}
        className="metric-overlay__plot chart"
        role="img"
        tabIndex={isTrend ? 0 : -1}
        aria-label={aria}
        onMouseMove={onMouse}
        onMouseLeave={() => setHover(null)}
        onTouchStart={onTouch}
        onTouchMove={onTouch}
        onKeyDown={onKeyDown}
      >
        <svg width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
          {isTrend &&
            yTicks.map((tick) => (
              <g key={tick}>
                <line className="chart__grid" x1={frame.left} x2={frame.right} y1={model.y(tick)} y2={model.y(tick)} />
                <text className="chart__tick" x={frame.left - 7} y={model.y(tick) + 3} textAnchor="end">
                  {formatTick(tick)}
                  {unit === "ratio" ? "%" : ""}
                </text>
              </g>
            ))}
          {isTrend && <line className="chart__axis" x1={frame.left} x2={frame.left} y1={frame.top} y2={frame.bottom} />}
          {isTrend &&
            [start, endAt].map((at, index) => (
              <text
                key={at}
                className="chart__tick"
                x={model.x(at)}
                y={mode === "overlay" ? 16 : frame.height - 6}
                textAnchor={index ? "end" : "start"}
              >
                {formatTime(at, windowSeconds, frame.width)}
              </text>
            ))}
          {mode === "overlay" && plotWidth >= 200 ? (
            <text className="chart__tick" x={(frame.left + frame.right) / 2} y={16} textAnchor="middle">
              Time
            </text>
          ) : null}
          {mode === "overlay" ? <line className="chart__axis" x1={frame.left} x2={frame.right} y1={frame.top} y2={frame.top} /> : null}

          {distribution && <line className="chart__axis" x1={frame.right} x2={frame.right} y1={frame.top} y2={frame.bottom} />}
          {distribution && meanBin >= 0 && (
            <rect
              className="metric-overlay__mean-bin"
              data-mean-bin={meanBin}
              x={model.histX(model.bins.binStart + meanBin * model.bins.binWidth)}
              y={frame.top}
              width={Math.max(0, model.histX(model.bins.binStart + (meanBin + 1) * model.bins.binWidth) - model.histX(model.bins.binStart + meanBin * model.bins.binWidth))}
              height={frame.bottom - frame.top}
            >
              <title>
                Bin containing mean {formatBin(mean!)} {model.displayUnit}
              </title>
            </rect>
          )}
          {distribution &&
            model.bins.counts.map((count, index) => {
              const value0 = model.bins.binStart + index * model.bins.binWidth;
              const value1 = value0 + model.bins.binWidth;
              const x0 = model.histX(value0);
              const x1 = model.histX(value1);
              return (
                <rect
                  key={index}
                  className={index === meanBin ? "metric-overlay__bar is-mean" : "metric-overlay__bar"}
                  x={x0 + 1}
                  y={model.histY(count)}
                  width={Math.max(0, x1 - x0 - 2)}
                  height={Math.max(0, frame.bottom - model.histY(count))}
                  rx={1}
                >
                  <title>
                    {formatBin(value0)}–{formatBin(value1)} {model.displayUnit}: {count} samples
                    {index === meanBin ? `; contains mean ${formatBin(mean!)} ${model.displayUnit}` : ""}
                  </title>
                </rect>
              );
            })}
          {distribution &&
            countTicks.map((tick) => (
              <g key={`count-${tick}`}>
                <line className="chart__axis" x1={frame.right} x2={frame.right + 3} y1={model.histY(tick)} y2={model.histY(tick)} />
                <text className="chart__tick" x={frame.right + 6} y={model.histY(tick) + 3} textAnchor="start">
                  {tick}
                </text>
              </g>
            ))}
          {distribution && (
            <text
              className="chart__tick"
              transform={`translate(${frame.width - 6} ${(frame.top + frame.bottom) / 2}) rotate(-90)`}
              textAnchor="middle"
            >
              Samples / bin
            </text>
          )}
          {distribution && model.observed.length > 0
            ? Array.from({ length: binTickCount + 1 }, (_, index) => {
                const value = model.bins.binStart + ((model.bins.binEnd - model.bins.binStart) * index) / binTickCount;
                return (
                  <g key={`bin-${index}`}>
                    <line className="chart__axis" x1={model.histX(value)} x2={model.histX(value)} y1={frame.bottom} y2={frame.bottom + 4} />
                    <text
                      className="chart__tick"
                      x={model.histX(value)}
                      y={frame.bottom + 16}
                      textAnchor={index === 0 ? "start" : index === binTickCount ? "end" : "middle"}
                    >
                      {formatBin(value)}
                    </text>
                  </g>
                );
              })
            : distribution && (
                <text className="chart__tick" x={(frame.left + frame.right) / 2} y={frame.bottom + 16} textAnchor="middle">
                  {excludeZeros ? "No nonzero samples" : "No samples"}
                </text>
              )}
          {distribution && mean != null && (
            <line className="metric-overlay__mean" x1={model.histX(mean)} x2={model.histX(mean)} y1={frame.top} y2={frame.bottom}>
              <title>
                Mean: {formatBin(mean)} {model.displayUnit}
              </title>
            </line>
          )}

          <line className="chart__axis" x1={frame.left} x2={frame.right} y1={frame.bottom} y2={frame.bottom} />
          {isTrend && model.path ? <path className="metric-overlay__line" d={model.path} /> : null}
          {isTrend &&
            runs.map((run, index) =>
              run.length === 1 ? <circle key={`dot-${index}`} cx={run[0].x} cy={run[0].y} r={2} className="metric-overlay__dot" /> : null
            )}
          {isTrend && lastPoint && runs.at(-1) && runs.at(-1)!.length > 1 ? (
            <circle cx={lastPoint.x} cy={lastPoint.y} r={2.5} className="metric-overlay__dot" />
          ) : null}
          {isTrend && active ? (
            <line className="metric-overlay__crosshair" x1={model.x(active.at)} x2={model.x(active.at)} y1={frame.top} y2={frame.bottom} />
          ) : null}
        </svg>
        {isTrend && active ? (
          <div className="chart__tip metric-overlay__tip" role="status" style={{ left: Math.min(Math.max(model.x(active.at), 72), frame.width - 72) }}>
            <b>{activeValue == null ? "Unavailable" : `${formatTick(activeValue)}${model.displayUnit ? ` ${model.displayUnit}` : ""}`}</b>
            <span className="chart__tip-foot">{formatTime(active.at, windowSeconds, frame.width)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SERIES = [
  { key: "generation", label: "Decode", unit: "tok/s", color: "var(--color-accent)" },
  { key: "prefill", label: "Prefill", unit: "tok/s", color: "var(--color-info)" },
  { key: "ttft", label: "TTFT", unit: "s", color: "var(--color-violet)" },
] as const;

/**
 * Overlay charts for one LLM panel. The ring lives here, per Spark and port.
 * A series the probe never publishes (null, not zero) is left off.
 */
export function LlmMetricOverlay({
  sparkId,
  llmPort,
  llm,
  active,
}: {
  sparkId: string;
  llmPort: number;
  llm: LlmMetrics | null;
  active: boolean;
}) {
  const rings = useLlmChartRings(sparkId, llmPort, llm, active);
  const present = {
    generation: seriesHasValues(rings.generation),
    prefill: seriesHasValues(rings.prefill),
    ttft: seriesHasValues(rings.ttft),
  };
  const any = present.generation || present.prefill || present.ttft;

  return (
    <div className="sp-section" data-llm-overlay={llmPort}>
      <div className="sp-section__head">
        <span className="eyebrow">Live</span>
        <span className="sp-muted">last 5 minutes</span>
      </div>
      {!any ? (
        <p className="sp-muted">Waiting for samples.</p>
      ) : (
        <div className="metric-overlay-stack">
          {SERIES.map((series) =>
            present[series.key] ? (
              <MetricOverlayChart
                key={series.key}
                label={series.label}
                unit={series.unit}
                color={series.color}
                mode="overlay"
                samples={rings[series.key]}
              />
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
