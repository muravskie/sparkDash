import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob, QualityCategory, ToolEvalRun } from "../../../api/types";
import {
  engineLabel,
  headlinesFromJobs,
  qualityCategories,
  type CampaignRun,
  type ToolEvalTemplate,
} from "./campaign";

export interface AdoptSources {
  decode: DecodeBenchJob[];
  prefill: PrefillBenchJob[];
  quality: QualityBenchJob[];
  tool: ToolEvalRun[];
}

export type AdoptResult = { kind: "ready"; run: CampaignRun } | { kind: "waiting" } | { kind: "missing" };

function newest<T extends { startedAt?: number }>(rows: T[]): T | null {
  return rows.reduce<T | null>((best, row) => (!best || (row.startedAt ?? 0) > (best.startedAt ?? 0) ? row : best), null);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].every((item, i) => item === b[i]);
}

function templateOf(options: Record<string, unknown> | undefined): ToolEvalTemplate {
  if (options?.["hardmode-only"] === true) return "hard";
  if (options?.hardmode === true) return "regular-hard";
  if (options?.short === true) return "short";
  return "regular";
}

/**
 * The newest completed decode, prefill, and quality on one port, in that order, plus the tool-eval
 * run that follows them. An older tool-eval does not count. A tool-eval that is still running
 * waits; it is not skipped and it is not cancelled.
 */
export function adoptFinishedCampaign(sparkId: string, sources: AdoptSources): AdoptResult {
  const decode = newest(sources.decode.filter((job) => job.status === "completed" && job.sparkId === sparkId));
  if (!decode) return { kind: "missing" };
  const port = decode.config?.port;
  const prefill = newest(sources.prefill.filter((job) =>
    job.status === "completed" && job.sparkId === sparkId && job.config?.port === port && job.startedAt >= decode.startedAt));
  if (!prefill) return { kind: "missing" };
  const quality = newest(sources.quality.filter((job) =>
    job.status === "completed" && job.sparkId === sparkId && job.config?.port === port && job.startedAt >= prefill.startedAt));
  if (!quality) return { kind: "missing" };

  const tools = sources.tool.filter((run) =>
    run.sparkId === sparkId && run.type === "tool-eval" && run.port === port && run.startedAt >= quality.startedAt);
  const running = tools.find((run) => run.status === "running");
  if (running) return { kind: "waiting" };
  const tool = newest(tools.filter((run) => run.status === "completed"));
  if (!tool) return { kind: "missing" };

  const categories = (quality.config?.categories ?? []) as QualityCategory[];
  const longSizes = quality.config?.longSizes ?? [];
  const defaultCats = qualityCategories("default");
  const longCats = qualityCategories("default-16k");
  const profile = sameList(categories, defaultCats)
    ? "default" as const
    : sameList(categories, longCats) && longSizes.length === 1 && longSizes[0] === 16384
      ? "default-16k" as const
      : "recorded" as const;

  const promptTypes = Array.isArray(decode.config?.promptTypes) && decode.config.promptTypes.length
    ? decode.config.promptTypes
    : decode.config?.promptType ? [decode.config.promptType] : [];

  const run: CampaignRun = {
    id: `camp-adopted-${decode.benchId}`,
    sparkId,
    port,
    modelId: decode.config?.modelId ?? null,
    engine: engineLabel(quality.engine?.record?.backend, quality.engine?.record?.engineVersion || quality.engine?.record?.gitCommit),
    host: null,
    tls: false,
    startedAt: decode.startedAt,
    completedAt: tool.finishedAt,
    status: "completed",
    stage: "tool-eval",
    config: {
      preset: "custom",
      decode: {
        thinking: decode.config?.thinking === true,
        temperature: Number(decode.config?.temperature ?? 0),
        concurrencies: [...(decode.config?.concurrencies ?? [])],
        contextTokens: Number(decode.config?.contextTokens ?? 0),
        promptTypes,
        maxTokens: Number(decode.config?.maxTokens ?? 400),
      },
      prefill: { contextSizes: [...(prefill.config?.contextSizes ?? [])] },
      quality: profile === "recorded"
        ? { profile, categories, longSizes: [...longSizes], longItems: quality.config?.longItems }
        : { profile },
      toolEval: { template: templateOf(tool.options) },
    },
    error: null,
    jobs: { decode: decode.benchId, prefill: prefill.benchId, quality: quality.benchId, toolEval: tool.id },
    headlines: headlinesFromJobs({ decode, prefill, quality, tool }),
  };
  return { kind: "ready", run };
}
