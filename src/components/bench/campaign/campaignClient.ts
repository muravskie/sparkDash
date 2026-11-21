import {
  fetchToolEvalRun,
  fetchToolEvalRuns,
  getDecodeBench,
  getPrefillBench,
  getQualityBench,
  listDecodeBench,
  listPrefillBench,
  listQualityBench,
  startDecodeBench,
  startPrefillBench,
  startQualityBench,
  startToolEvalRun,
} from "../../../api/client";
import type { LlmBenchTarget } from "../../../api/types";
import { formatLlmBaseUrl } from "../../../shared/llmTarget.js";
import {
  CAMPAIGN_QUALITY_CONCURRENCY,
  QUALITY_DEFAULT_LONG_ITEMS,
  CAMPAIGN_LONG_RECALL_TOKENS,
  qualityCategories,
  toolEvalOptions,
  type CampaignRun,
} from "./campaign";
import type { CampaignClient } from "./campaignRunner";

function endpoint(run: CampaignRun): { host?: string; tls?: boolean } {
  return run.host ? { host: run.host, tls: run.tls } : {};
}

export function campaignClient(): CampaignClient {
  return {
    async busy(sparkId, ownJobIds) {
      const own = new Set(ownJobIds);
      const [decode, prefill, quality, tool] = await Promise.all([
        listDecodeBench(sparkId),
        listPrefillBench(sparkId),
        listQualityBench(sparkId),
        fetchToolEvalRuns(sparkId),
      ]);
      if (decode.active && !own.has(decode.active.benchId)) return "decode";
      if (prefill.active && !own.has(prefill.active.benchId)) return "prefill";
      if (quality.active && !own.has(quality.active.benchId)) return "quality";
      if (tool.active && !own.has(tool.active.id)) {
        return tool.active.kind === "install" ? "install" : "tool-eval";
      }
      return null;
    },
    async startDecode(run) {
      const job = await startDecodeBench(run.sparkId, {
        port: run.port,
        modelId: run.modelId,
        concurrencies: run.config.decode.concurrencies,
        maxTokens: run.config.decode.maxTokens,
        promptTypes: run.config.decode.promptTypes,
        temperature: run.config.decode.temperature,
        thinking: run.config.decode.thinking,
        ...(run.config.decode.contextTokens > 0 ? { contextTokens: run.config.decode.contextTokens } : {}),
        ...endpoint(run),
      });
      return job.benchId;
    },
    async pollDecode(run, id) {
      const job = await getDecodeBench(run.sparkId, id);
      return { status: job.status, error: job.error, job };
    },
    async startPrefill(run) {
      const job = await startPrefillBench(run.sparkId, {
        port: run.port,
        modelId: run.modelId,
        contextSizes: run.config.prefill.contextSizes,
        ...endpoint(run),
      });
      return job.benchId;
    },
    async pollPrefill(run, id) {
      const job = await getPrefillBench(run.sparkId, id);
      return { status: job.status, error: job.error, job };
    },
    async startQuality(run) {
      const profile = run.config.quality.profile;
      const job = await startQualityBench(run.sparkId, {
        port: run.port,
        modelId: run.modelId,
        categories: qualityCategories(profile),
        concurrency: CAMPAIGN_QUALITY_CONCURRENCY,
        label: "campaign",
        ...(profile === "default-16k"
          ? { longSizes: [CAMPAIGN_LONG_RECALL_TOKENS], longItems: QUALITY_DEFAULT_LONG_ITEMS }
          : {}),
        ...endpoint(run),
      });
      return job.benchId;
    },
    async pollQuality(run, id) {
      const job = await getQualityBench(run.sparkId, id);
      return { status: job.status, error: job.error, job };
    },
    async startToolEval(run) {
      const options: Record<string, unknown> = { ...toolEvalOptions(run.config.toolEval.template) };
      if (run.host) options["base-url"] = formatLlmBaseUrl({ host: run.host, port: run.port, tls: run.tls });
      const started = await startToolEvalRun(run.sparkId, {
        type: "tool-eval",
        port: run.port,
        options,
        useSavedKey: run.host ? false : undefined,
      });
      return started.run.id;
    },
    async pollToolEval(run, id) {
      const { run: job } = await fetchToolEvalRun(run.sparkId, id);
      return { status: job.status, error: job.exitCode != null && job.exitCode !== 0 ? `exit ${job.exitCode}` : null, job };
    },
  };
}

export function remoteOf(target: LlmBenchTarget | null): { host: string | null; tls: boolean; port: number | null } {
  if (!target) return { host: null, tls: false, port: null };
  return { host: target.host, tls: target.tls, port: target.port };
}
