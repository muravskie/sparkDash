import { useEffect, useState } from "react";
import type { LlmMetrics } from "../../api/types";
import { appendChartSample, type ChartSample } from "./chartGeometry";

/** Half an hour at the usual poll, matching the metric chart's short retention. */
export const CHART_MAX_SAMPLES = 600;
export const CHART_MAX_WINDOW_MS = 30 * 60 * 1000;
export const CHART_WINDOW_SECONDS = 300;

export interface LlmChartRings {
  key: string;
  generation: ChartSample[];
  prefill: ChartSample[];
  ttft: ChartSample[];
  source: object | null;
}

const rings = new Map<string, LlmChartRings>();

export function llmChartKey(sparkId: string, port: number): string {
  return `${sparkId}:${port}`;
}

function emptyRings(key: string): LlmChartRings {
  return { key, generation: [], prefill: [], ttft: [], source: null };
}

export function readLlmChartRings(key: string): LlmChartRings {
  return rings.get(key) ?? emptyRings(key);
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Append one poll for this Spark and port. The same snapshot object is ignored,
 * so a re-render does not invent an extra sample. Null means the probe did not
 * publish that reading; it is stored as a gap, not as zero.
 */
export function recordLlmChartSample(key: string, source: object, at: number, llm: LlmMetrics): LlmChartRings {
  const prev = rings.get(key);
  if (prev && prev.source === source) return prev;
  const next: LlmChartRings = {
    key,
    source,
    generation: appendChartSample(prev?.generation ?? [], { at, value: finiteNumber(llm.generationTps) }, CHART_MAX_SAMPLES, CHART_MAX_WINDOW_MS),
    prefill: appendChartSample(prev?.prefill ?? [], { at, value: finiteNumber(llm.prefillTps) }, CHART_MAX_SAMPLES, CHART_MAX_WINDOW_MS),
    ttft: appendChartSample(prev?.ttft ?? [], { at, value: finiteNumber(llm.ttftSeconds) }, CHART_MAX_SAMPLES, CHART_MAX_WINDOW_MS),
  };
  rings.set(key, next);
  return next;
}

export function resetLlmChartRings(): void {
  rings.clear();
}

export function seriesHasValues(samples: readonly ChartSample[]): boolean {
  return samples.some((sample) => sample.value != null && Number.isFinite(sample.value));
}

/** Per-panel ring. Keyed by Spark and port so two LLM panels never share a line. */
export function useLlmChartRings(sparkId: string, llmPort: number, llm: LlmMetrics | null, active: boolean): LlmChartRings {
  const key = llmChartKey(sparkId, llmPort);
  const [ringsKey, setRingsKey] = useState(key);
  const [stored, setStored] = useState(() => readLlmChartRings(key));

  if (ringsKey !== key) {
    setRingsKey(key);
    setStored(readLlmChartRings(key));
  }

  useEffect(() => {
    if (!active || !llm) {
      setStored(readLlmChartRings(key));
      return;
    }
    setStored(recordLlmChartSample(key, llm, Date.now(), llm));
  }, [key, active, llm]);

  return ringsKey === key ? stored : readLlmChartRings(key);
}
