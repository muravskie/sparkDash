import type { DecodeBenchPromptType, QualityCategory } from "../../../api/types";
import { DECODE_BENCH_TYPES } from "../../../shared/llmPrompts.js";
import { backendLabel } from "../../../shared/llmBackends.js";
import { QUALITY_CATEGORIES, QUALITY_DEFAULT_CATEGORIES, QUALITY_DEFAULT_LONG_ITEMS } from "../../../shared/qualityBench.js";

/** Decode start-context choices. 0 starts empty. */
export const CAMPAIGN_DECODE_CONTEXTS = [0, 16384, 32768, 65536, 131072, 262144] as const;
/** Prefill sizes the campaign form offers. 1k–128k is the full sweep. */
export const CAMPAIGN_PREFILL_SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072] as const;
/** Every concurrency the decode bench accepts, through the 1–32 sweep. */
export const CAMPAIGN_CONCURRENCIES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32] as const;
/** Long-recall sizes. The saved full run recorded 16k; 128k matches the top of the prefill sweep. */
export const CAMPAIGN_LONG_SIZES = [32768, 65536, 131072, 262144] as const;
export const CAMPAIGN_PROMPT_TYPES = DECODE_BENCH_TYPES;
export const CAMPAIGN_LONG_RECALL_TOKENS = 16384;
export const CAMPAIGN_QUALITY_CONCURRENCY = 4;

/** "full" is the sweep preset. Headline and Detailed are result views, not run presets. */
export type CampaignPreset = "full" | "custom";
export type QualityCampaignProfile = "default" | "full" | "default-16k" | "recorded";
export type CampaignView = "headline" | "detailed";
export type ToolEvalTemplate = "short" | "regular" | "regular-hard" | "hard";
export type CampaignStage = "decode" | "prefill" | "quality" | "tool-eval";

export const CAMPAIGN_STAGES: readonly CampaignStage[] = ["decode", "prefill", "quality", "tool-eval"];

export interface CampaignConfig {
  preset: CampaignPreset;
  decode: {
    thinking: boolean;
    temperature: number;
    concurrencies: number[];
    contextTokens: number;
    promptTypes: DecodeBenchPromptType[];
    maxTokens: number;
  };
  prefill: { contextSizes: number[] };
  quality: {
    profile: QualityCampaignProfile;
    /** Set for a recorded run whose categories are not one of the two campaign profiles. */
    categories?: QualityCategory[];
    longSizes?: number[];
    longItems?: number;
  };
  toolEval: { template: ToolEvalTemplate };
}

export interface CampaignLevel {
  type: string;
  concurrency: number;
  aggregate: number;
}

export interface CampaignPrefillRow {
  tokens: number;
  tps: number;
}

export interface CampaignHeadlines {
  /** Mean aggregate tok/s at concurrency 1, across the prompt types that produced one. */
  decodeAgg: number | null;
  /** Prefill tok/s at the largest measured context size. */
  prefillTps: number | null;
  qualityPct: number | null;
  toolScore: number | null;
  decodeLevels: CampaignLevel[];
  prefillRows: CampaignPrefillRow[];
}

export interface CampaignJobs {
  decode?: string;
  prefill?: string;
  quality?: string;
  toolEval?: string;
}

export interface CampaignRun {
  id: string;
  sparkId: string;
  port: number;
  modelId: string | null;
  /** Engine name and version that served this run. Null on older saved campaigns. */
  engine: string | null;
  /** Remote host when the run is not on the Spark's own port. */
  host: string | null;
  tls: boolean;
  startedAt: number;
  completedAt: number | null;
  status: "running" | "completed" | "failed" | "stopped";
  /** Stage in progress, or the last stage that started. */
  stage: CampaignStage | null;
  config: CampaignConfig;
  error: string | null;
  jobs: CampaignJobs;
  headlines: CampaignHeadlines;
}

export interface ToolEvalOptions {
  seed: number;
  short?: boolean;
  hardmode?: boolean;
  "hardmode-only"?: boolean;
}

const EMPTY_HEADLINES = (): CampaignHeadlines => ({
  decodeAgg: null,
  prefillTps: null,
  qualityPct: null,
  toolScore: null,
  decodeLevels: [],
  prefillRows: [],
});

function orderedTypes(types: readonly string[]): string[] {
  return CAMPAIGN_PROMPT_TYPES.filter((type) => types.includes(type as DecodeBenchPromptType));
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
}

/** The sweep this host actually runs: thinking on, concurrency 1–32, prefill 1k–128k, full quality suite. */
export function fullSweepConfig(): CampaignConfig {
  return {
    preset: "full",
    decode: {
      thinking: true,
      temperature: 0.7,
      concurrencies: [...CAMPAIGN_CONCURRENCIES],
      contextTokens: 16384,
      promptTypes: [...CAMPAIGN_PROMPT_TYPES],
      maxTokens: 400,
    },
    prefill: { contextSizes: [...CAMPAIGN_PREFILL_SIZES] },
    quality: { profile: "full", longSizes: [131072], longItems: QUALITY_DEFAULT_LONG_ITEMS },
    toolEval: { template: "regular-hard" },
  };
}

/** Mark a hand-edited config as custom. The knobs themselves are what a later compare uses. */
export function asCustom(config: CampaignConfig): CampaignConfig {
  return { ...config, preset: "custom" };
}

function qualityStamp(quality: CampaignConfig["quality"]): string {
  if (quality.profile === "default") return "default";
  return JSON.stringify({
    profile: quality.profile,
    categories: quality.categories ?? null,
    longSizes: sortedUnique(quality.longSizes ?? (quality.profile === "default-16k" ? [CAMPAIGN_LONG_RECALL_TOKENS] : [])),
    longItems: quality.longItems ?? null,
  });
}

export function qualityCategories(profile: QualityCampaignProfile): QualityCategory[] {
  if (profile === "full") return [...QUALITY_CATEGORIES] as QualityCategory[];
  const base = [...QUALITY_DEFAULT_CATEGORIES] as QualityCategory[];
  return profile === "default-16k" ? [...base, "long"] : base;
}

export function toolEvalOptions(template: ToolEvalTemplate): ToolEvalOptions {
  if (template === "short") return { short: true, seed: 42 };
  if (template === "regular-hard") return { hardmode: true, seed: 42 };
  if (template === "hard") return { "hardmode-only": true, seed: 42 };
  return { seed: 42 };
}

/** Knobs that must match before two campaigns share a headline. Preset name is not one of them. */
export function campaignSignature(config: CampaignConfig): string {
  return JSON.stringify({
    decode: {
      thinking: config.decode.thinking,
      temperature: config.decode.temperature,
      concurrencies: sortedUnique(config.decode.concurrencies),
      contextTokens: config.decode.contextTokens,
      promptTypes: orderedTypes(config.decode.promptTypes),
      maxTokens: config.decode.maxTokens,
    },
    prefill: { contextSizes: sortedUnique(config.prefill.contextSizes) },
    quality: qualityStamp(config.quality),
    toolEval: config.toolEval.template,
  });
}

export type CampaignDiffField =
  | "decode.thinking"
  | "decode.temperature"
  | "decode.concurrencies"
  | "decode.context"
  | "decode.promptTypes"
  | "decode.maxTokens"
  | "prefill.context"
  | "quality.profile"
  | "toolEval.template";

export function campaignDiffs(a: CampaignConfig, b: CampaignConfig): CampaignDiffField[] {
  const out: CampaignDiffField[] = [];
  if (a.decode.thinking !== b.decode.thinking) out.push("decode.thinking");
  if (a.decode.temperature !== b.decode.temperature) out.push("decode.temperature");
  if (sortedUnique(a.decode.concurrencies).join() !== sortedUnique(b.decode.concurrencies).join()) out.push("decode.concurrencies");
  if (a.decode.contextTokens !== b.decode.contextTokens) out.push("decode.context");
  if (orderedTypes(a.decode.promptTypes).join() !== orderedTypes(b.decode.promptTypes).join()) out.push("decode.promptTypes");
  if (a.decode.maxTokens !== b.decode.maxTokens) out.push("decode.maxTokens");
  if (sortedUnique(a.prefill.contextSizes).join() !== sortedUnique(b.prefill.contextSizes).join()) out.push("prefill.context");
  if (qualityStamp(a.quality) !== qualityStamp(b.quality)) out.push("quality.profile");
  if (a.toolEval.template !== b.toolEval.template) out.push("toolEval.template");
  return out;
}

export function campaignsComparable(a: CampaignConfig, b: CampaignConfig): boolean {
  return campaignDiffs(a, b).length === 0;
}

/** Wall-clock section time. Hours when the run is long; seconds only under a minute. */
export function formatSectionDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** One row per decode job. A campaign the page adopted is the same run as the one that started those jobs. */
export function dedupeCampaigns(runs: CampaignRun[]): CampaignRun[] {
  const byKey = new Map<string, CampaignRun>();
  const order: string[] = [];
  for (const run of runs) {
    const key = run.jobs.decode ? `job:${run.jobs.decode}` : `id:${run.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, run);
      order.push(key);
      continue;
    }
    if (prev.id.startsWith("camp-adopted-") && !run.id.startsWith("camp-adopted-")) byKey.set(key, run);
  }
  return order.map((key) => byKey.get(key)!);
}

export function newCampaignId(now = Date.now(), rand = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `camp-${now.toString(36)}-${suffix}`;
}

/** Name and version together. A version already inside the name is not repeated. */
export function engineLabel(backend: string | null | undefined, version?: string | null): string | null {
  const name = backendLabel(backend);
  const ver = version?.trim() || "";
  if (!name) return ver || null;
  if (!ver || name.includes(ver)) return name;
  return `${name} ${ver}`;
}

/**
 * The engine measured on the quality job wins over a label copied from whatever
 * is serving the port today. A stored version is kept when the measurement names
 * the same engine and did not record a version.
 */
export function campaignEngine(
  stored: string | null | undefined,
  record: { backend?: string | null; engineVersion?: string | null; gitCommit?: string | null } | null | undefined,
): string | null {
  const measured = record ? engineLabel(record.backend, record.engineVersion || record.gitCommit) : null;
  if (!measured) return stored ?? null;
  if (!stored || stored === measured) return measured;
  const name = backendLabel(record?.backend);
  const measuredHasVersion = Boolean(record?.engineVersion?.trim() || record?.gitCommit?.trim());
  if (!measuredHasVersion && name && (stored === name || stored.startsWith(`${name} `))) return stored;
  return measured;
}

export function campaignTitle(run: Pick<CampaignRun, "modelId" | "engine">): string {
  if (run.modelId && run.engine) return `${run.modelId} · ${run.engine}`;
  return run.modelId || run.engine || "";
}

/** The running registry profile on this port. A stopped profile that shares the port is not serving. */
export function registryEngine(
  models: readonly { endpoint: string | null; runtime: string; engine: string | null }[],
  port: number,
): string | null {
  const hit = models.find((model) => model.runtime === "running" && model.engine && portOf(model.endpoint) === port);
  return hit?.engine ?? null;
}

function portOf(endpoint: string | null): number | null {
  if (!endpoint) return null;
  try {
    const port = Number(new URL(endpoint).port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export function createCampaign(input: {
  sparkId: string;
  port: number;
  modelId: string | null;
  engine?: string | null;
  host?: string | null;
  tls?: boolean;
  config: CampaignConfig;
  now?: number;
}): CampaignRun {
  return {
    id: newCampaignId(input.now),
    sparkId: input.sparkId,
    port: input.port,
    modelId: input.modelId,
    engine: input.engine ?? null,
    host: input.host ?? null,
    tls: input.tls === true,
    startedAt: input.now ?? Date.now(),
    completedAt: null,
    status: "running",
    stage: null,
    config: input.config,
    error: null,
    jobs: {},
    headlines: EMPTY_HEADLINES(),
  };
}

interface DecodeLike {
  results?: Array<{ promptType?: string; concurrency?: number; aggregateDecodeTps?: number; meanDecodeTps?: number; error?: string | null }>;
}

interface PrefillLike {
  results?: Array<{ targetTokens?: number; prefillTps?: number; error?: string | null }>;
}

interface QualityLike {
  results?: { overallPct?: number | null } | null;
}

interface ToolLike {
  summary?: { finalScore?: number | null } | null;
}

function finite(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Fill the headline numbers from the finished child jobs. Missing jobs leave their cells empty. */
export function headlinesFromJobs(jobs: {
  decode?: DecodeLike | null;
  prefill?: PrefillLike | null;
  quality?: QualityLike | null;
  tool?: ToolLike | null;
}): CampaignHeadlines {
  const levels: CampaignLevel[] = [];
  for (const row of jobs.decode?.results ?? []) {
    if (row.error) continue;
    const aggregate = finite(row.aggregateDecodeTps) ?? finite(row.meanDecodeTps);
    if (aggregate == null || aggregate <= 0) continue;
    levels.push({ type: row.promptType || "structured", concurrency: Number(row.concurrency) || 0, aggregate });
  }
  const atOne = levels.filter((row) => row.concurrency === 1);
  const decodeAgg = atOne.length ? atOne.reduce((sum, row) => sum + row.aggregate, 0) / atOne.length : null;
  const prefillRows: CampaignPrefillRow[] = [];
  for (const row of jobs.prefill?.results ?? []) {
    const tps = finite(row.prefillTps);
    if (row.error || tps == null || tps <= 0) continue;
    prefillRows.push({ tokens: Number(row.targetTokens) || 0, tps });
  }
  const largest = prefillRows.reduce<CampaignPrefillRow | null>((best, row) => (!best || row.tokens > best.tokens ? row : best), null);
  return {
    decodeAgg,
    prefillTps: largest?.tps ?? null,
    qualityPct: finite(jobs.quality?.results?.overallPct),
    toolScore: finite(jobs.tool?.summary?.finalScore),
    decodeLevels: levels,
    prefillRows,
  };
}

export { QUALITY_DEFAULT_LONG_ITEMS };
