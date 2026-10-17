import type { DecodeBenchJob, DecodeBenchLevelResult, DecodeBenchPromptType } from "../../api/types";
import { decodeBenchTypeLabel, promptTypesOf } from "../../shared/llmPrompts.js";

/** Overlap under this is clearly below 1 — a 10% gap, not rounding. */
export const OVERLAP_CLEAR = 0.9;
/** First-token times at least this far apart count as spread. */
export const TTFT_SPREAD_MS = 100;

/** Mean of each stream's own tok/s. */
export function streamTps(r: DecodeBenchLevelResult): number {
  return r.meanDecodeTps;
}

/** Rates added: streams that produced tokens times the mean. Not a simultaneous rate. */
export function sumTps(r: DecodeBenchLevelResult): number {
  const streams = Number(r.streamsOk);
  const mean = Number(r.meanDecodeTps);
  if (!Number.isFinite(streams) || !Number.isFinite(mean)) return 0;
  return streams * mean;
}

/** Stored shared-window aggregate. Not recomputed here. */
export function aggregateTps(r: DecodeBenchLevelResult): number {
  return r.aggregateDecodeTps;
}

/** Aggregate ÷ sum when sum is positive. */
export function overlapRatio(r: DecodeBenchLevelResult): number | null {
  const sum = sumTps(r);
  if (!(sum > 0)) return null;
  return r.aggregateDecodeTps / sum;
}

/** Max TTFT minus min TTFT across streams that produced tokens. */
export function ttftSpreadMs(r: DecodeBenchLevelResult): number | null {
  const ttfts = (r.streams ?? [])
    .filter((s) => !s.error && ((s.decodeTokens ?? 0) > 0 || (s.completionTokens ?? 0) > 0 || s.decodeTps > 0))
    .map((s) => s.ttftMs)
    .filter((n) => Number.isFinite(n));
  if (ttfts.length < 2) return null;
  return Math.max(...ttfts) - Math.min(...ttfts);
}

/**
 * The shared window is mostly idle: overlap is clearly under 1 and first-token
 * times are spread, so the streams did not run together.
 */
export function streamsDidNotOverlap(r: DecodeBenchLevelResult): boolean {
  const overlap = overlapRatio(r);
  if (overlap == null || overlap >= OVERLAP_CLEAR) return false;
  const spread = ttftSpreadMs(r);
  return spread != null && spread >= TTFT_SPREAD_MS;
}

/** Per-stream start and end, as offsets from the earliest first token in the wave. */
export function streamWindowTitle(r: DecodeBenchLevelResult): string {
  const streams = r.streams ?? [];
  if (!streams.length) return "";
  const firsts = streams.map((s) => s.tFirst).filter((t): t is number => t != null && Number.isFinite(t));
  const origin = firsts.length ? Math.min(...firsts) : null;
  return streams
    .map((s) => {
      if (origin != null && s.tFirst != null && s.tLast != null) {
        const start = Math.round(s.tFirst - origin);
        const end = Math.round(s.tLast - origin);
        return `#${s.index} +${start}ms → +${end}ms`;
      }
      return `#${s.index} TTFT ${Math.round(s.ttftMs)}ms`;
    })
    .join("\n");
}

export interface DecodeResultGroup {
  type: DecodeBenchPromptType | null;
  /** Heading when the job has more than one type. */
  label: string | null;
  rows: DecodeBenchLevelResult[];
}

/** Group waves by prompt type, then keep concurrency order. One type stays a flat list. */
export function groupDecodeResults(job: DecodeBenchJob): DecodeResultGroup[] {
  const types = promptTypesOf(job.config);
  const rows = job.results ?? [];
  const distinct = new Set(rows.map((r) => r.promptType).filter((t): t is DecodeBenchPromptType => Boolean(t)));
  if (types.length <= 1 && distinct.size <= 1) {
    return [{ type: types[0] ?? rows.find((r) => r.promptType)?.promptType ?? null, label: null, rows }];
  }
  const order: DecodeBenchPromptType[] = types.length ? types : [...distinct];
  const groups: DecodeResultGroup[] = order
    .map((type) => ({
      type,
      label: decodeBenchTypeLabel(type),
      rows: rows.filter((r) => (r.promptType ?? types[0]) === type),
    }))
    .filter((g) => g.rows.length > 0);
  const placed = new Set(groups.flatMap((g) => g.rows));
  const rest = rows.filter((r) => !placed.has(r));
  if (rest.length) groups.push({ type: null, label: null, rows: rest });
  return groups;
}
