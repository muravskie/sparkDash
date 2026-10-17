import type { DecodeBenchJob, DecodeBenchLevelResult, PrefillBenchJob } from "../../api/types";
import { decodeBenchTypeLabel, promptTypesOf, type DecodeBenchPromptType } from "../../shared/llmPrompts.js";
import { formatContextSize } from "../../shared/prefillBench.js";

export interface ThroughputCheck {
  ok: boolean;
  /** Why the runs cannot be paired. Null when they share a setup. */
  reason: string | null;
}

export interface ThroughputCompareRow {
  key: string;
  /** Type heading, set when a decode job has more than one type. */
  group: string | null;
  level: string;
  /** Aggregate tok/s (decode) or prefill tok/s. Null when that side has no score. */
  primaryA: number | null;
  primaryB: number | null;
  /** Stream tok/s. Null for prefill, and when that side has no score. */
  secondaryA: number | null;
  secondaryB: number | null;
}

export function formatTokDelta(d: number | null): string {
  if (d == null || !Number.isFinite(d)) return "—";
  const n = Math.round(d * 10) / 10;
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}

export function tokDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.round((a - b) * 10) / 10;
}

function modelOf(job: { config?: { modelId?: string | null }; results?: Array<{ model?: string | null }> }): string {
  return (job.config?.modelId || job.results?.find((r) => r.model)?.model || "").trim();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function typeLabel(types: readonly DecodeBenchPromptType[]): string {
  return types.length ? types.map((t) => decodeBenchTypeLabel(t)).join(", ") : "none";
}

/** Decode runs pair when they name the same model and the same prompt-type set. */
export function checkDecodeComparable(a: DecodeBenchJob | null, b: DecodeBenchJob | null): ThroughputCheck {
  if (!a || !b) return { ok: false, reason: "Pick two finished runs to compare." };
  const reasons: string[] = [];
  const modelA = modelOf(a);
  const modelB = modelOf(b);
  if (!modelA || !modelB || modelA !== modelB) {
    reasons.push(
      !modelA && !modelB
        ? "Neither run names a model, so they cannot be paired."
        : `Different models (${modelA || "unknown"} vs ${modelB || "unknown"}).`
    );
  }
  const typesA = promptTypesOf(a.config);
  const typesB = promptTypesOf(b.config);
  if (!typesA.length || !typesB.length || !sameList(typesA, typesB)) {
    reasons.push(
      !typesA.length || !typesB.length
        ? "One run does not record a prompt type."
        : `Different prompt types (${typeLabel(typesA)} vs ${typeLabel(typesB)}).`
    );
  }
  if (reasons.length) return { ok: false, reason: reasons.join(" ") };
  return { ok: true, reason: null };
}

function scoredDecode(r: DecodeBenchLevelResult | undefined): { aggregate: number; stream: number } | null {
  if (!r) return null;
  if (!(r.totalDecodeTokens > 0) && !(r.totalCompletionTokens > 0)) return null;
  return { aggregate: r.aggregateDecodeTps, stream: r.meanDecodeTps };
}

function indexDecode(job: DecodeBenchJob): Map<string, DecodeBenchLevelResult> {
  const types = promptTypesOf(job.config);
  const fallback = types.length === 1 ? types[0] : null;
  const map = new Map<string, DecodeBenchLevelResult>();
  for (const r of job.results ?? []) {
    const type = r.promptType ?? fallback;
    if (!type) continue;
    map.set(`${type}:${r.concurrency}`, r);
  }
  return map;
}

/** Aggregate and stream tok/s at each type and concurrency. Empty when the runs cannot be paired. */
export function compareDecodeRuns(a: DecodeBenchJob | null, b: DecodeBenchJob | null): ThroughputCompareRow[] {
  if (!checkDecodeComparable(a, b).ok || !a || !b) return [];
  const types = promptTypesOf(a.config);
  const ia = indexDecode(a);
  const ib = indexDecode(b);
  const conc = new Set<number>();
  for (const r of [...(a.results ?? []), ...(b.results ?? [])]) conc.add(r.concurrency);
  const levels = [...conc].filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  const multi = types.length > 1;
  const rows: ThroughputCompareRow[] = [];
  for (const type of types) {
    for (const c of levels) {
      const sa = scoredDecode(ia.get(`${type}:${c}`));
      const sb = scoredDecode(ib.get(`${type}:${c}`));
      rows.push({
        key: `${type}:${c}`,
        group: multi ? decodeBenchTypeLabel(type) : null,
        level: `×${c}`,
        primaryA: sa?.aggregate ?? null,
        primaryB: sb?.aggregate ?? null,
        secondaryA: sa?.stream ?? null,
        secondaryB: sb?.stream ?? null,
      });
    }
  }
  return rows;
}

function sizesOf(job: PrefillBenchJob): number[] {
  const raw = job.config?.contextSizes;
  if (!Array.isArray(raw)) return [];
  return [...raw].map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

function sizeLabel(sizes: readonly number[]): string {
  return sizes.length ? sizes.map((n) => formatContextSize(n)).join(", ") : "none";
}

/** Prefill runs pair when they used the same context sizes. */
export function checkPrefillComparable(a: PrefillBenchJob | null, b: PrefillBenchJob | null): ThroughputCheck {
  if (!a || !b) return { ok: false, reason: "Pick two finished runs to compare." };
  const sa = sizesOf(a);
  const sb = sizesOf(b);
  if (!sa.length || !sb.length || sa.length !== sb.length || sa.some((n, i) => n !== sb[i])) {
    return {
      ok: false,
      reason: !sa.length || !sb.length
        ? "One run does not record context sizes."
        : `Different context sizes (${sizeLabel(sa)} vs ${sizeLabel(sb)}).`,
    };
  }
  return { ok: true, reason: null };
}

/** Prefill tok/s at each context size. Empty when the runs cannot be paired. */
export function comparePrefillRuns(a: PrefillBenchJob | null, b: PrefillBenchJob | null): ThroughputCompareRow[] {
  if (!checkPrefillComparable(a, b).ok || !a || !b) return [];
  const by = (job: PrefillBenchJob) => {
    const map = new Map<number, number>();
    for (const r of job.results ?? []) {
      if (r.error || !(r.prefillTps > 0)) continue;
      map.set(r.targetTokens, r.prefillTps);
    }
    return map;
  };
  const ia = by(a);
  const ib = by(b);
  return sizesOf(a).map((n) => ({
    key: String(n),
    group: null,
    level: formatContextSize(n),
    primaryA: ia.has(n) ? ia.get(n)! : null,
    primaryB: ib.has(n) ? ib.get(n)! : null,
    secondaryA: null,
    secondaryB: null,
  }));
}
