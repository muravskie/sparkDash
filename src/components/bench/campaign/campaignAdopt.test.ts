import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob, ToolEvalRun } from "../../../api/types";
import { adoptFinishedCampaign } from "./campaignAdopt";

const decode = {
  benchId: "d", sparkId: "spark", status: "completed", startedAt: 100, completedAt: 200,
  config: { port: 8000, modelId: "Qwen/Qwen3.8-Flash-Next", concurrencies: [1, 2], maxTokens: 400, promptTypes: ["prose"], temperature: 0.7, thinking: true, contextTokens: 16384 },
  results: [{ promptType: "prose", concurrency: 1, aggregateDecodeTps: 33 }],
} as DecodeBenchJob;

const prefill = {
  benchId: "p", sparkId: "spark", status: "completed", startedAt: 300, completedAt: 400,
  config: { port: 8000, modelId: "Qwen/Qwen3.8-Flash-Next", contextSizes: [16384] },
  results: [{ targetTokens: 16384, prefillTps: 900 }],
} as PrefillBenchJob;

const quality = {
  benchId: "q", sparkId: "spark", status: "completed", startedAt: 500, completedAt: 600,
  config: { port: 8000, modelId: "Qwen/Qwen3.8-Flash-Next", categories: ["qa", "reason", "arith", "track", "gsm8k", "mmlupro", "math500", "long"], longSizes: [16384], longItems: 3 },
  results: { overallPct: 93.2 },
  engine: { probedAt: 1, capabilities: null, record: { backend: "vllm", engineVersion: "0.30.0", gitCommit: null } },
} as QualityBenchJob;

function tool(partial: Partial<ToolEvalRun>): ToolEvalRun {
  return {
    id: "te-new", sparkId: "spark", type: "tool-eval", status: "completed", startedAt: 700, finishedAt: 800,
    port: 8000, options: { seed: 42 }, summary: { finalScore: 88 }, ...partial,
  } as ToolEvalRun;
}

describe("adopt a finished session", () => {
  it("waits while tool-eval is still running and ignores an older completed run", () => {
    const older = tool({ id: "te-old", startedAt: 1, finishedAt: 50, status: "completed" });
    const live = tool({ id: "te-live", startedAt: 650, status: "running", finishedAt: null, summary: null });
    const result = adoptFinishedCampaign("spark", { decode: [decode], prefill: [prefill], quality: [quality], tool: [older, live] });
    expect(result.kind).toBe("waiting");
  });

  it("records the session once the tool-eval that follows quality has finished", () => {
    const older = tool({ id: "te-old", startedAt: 1, finishedAt: 50, summary: { finalScore: 10 } as ToolEvalRun["summary"] });
    const done = tool({ options: { short: true, seed: 42 } });
    const result = adoptFinishedCampaign("spark", { decode: [decode], prefill: [prefill], quality: [quality], tool: [older, done] });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.run.id).toBe("camp-adopted-d");
    expect(result.run.jobs.toolEval).toBe("te-new");
    expect(result.run.headlines.toolScore).toBe(88);
    expect(result.run.headlines.decodeAgg).toBe(33);
    expect(result.run.config.toolEval.template).toBe("short");
    expect(result.run.config.decode.thinking).toBe(true);
    expect(result.run.config.quality.profile).toBe("recorded");
    expect(result.run.engine).toBe("vLLM 0.30.0");
  });
});
