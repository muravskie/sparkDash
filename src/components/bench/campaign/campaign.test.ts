import { describe, expect, it } from "vitest";
import {
  campaignDiffs,
  campaignEngine,
  campaignTitle,
  campaignsComparable,
  createCampaign,
  engineLabel,
  registryEngine,
  dedupeCampaigns,
  formatSectionDuration,
  fullSweepConfig,
  headlinesFromJobs,
  qualityCategories,
  toolEvalOptions,
} from "./campaign";
import { runCampaign, type CampaignClient } from "./campaignRunner";

function client(partial: Partial<CampaignClient> = {}): CampaignClient {
  const started: string[] = [];
  const base: CampaignClient = {
    busy: async () => null,
    startDecode: async () => { started.push("decode"); return "d1"; },
    pollDecode: async () => ({ status: "completed", job: { results: [{ promptType: "prose", concurrency: 1, aggregateDecodeTps: 40 }] } }),
    startPrefill: async () => { started.push("prefill"); return "p1"; },
    pollPrefill: async () => ({ status: "completed", job: { results: [{ targetTokens: 16384, prefillTps: 1000 }] } }),
    startQuality: async () => { started.push("quality"); return "q1"; },
    pollQuality: async () => ({ status: "completed", job: { results: { overallPct: 80 } } }),
    startToolEval: async () => { started.push("tool-eval"); return "t1"; },
    pollToolEval: async () => ({ status: "completed", job: { summary: { finalScore: 70 } } }),
  };
  const merged = { ...base, ...partial };
  (merged as CampaignClient & { started: string[] }).started = started;
  return merged;
}

describe("campaign config", () => {
  it("describes the full sweep, not a short preset", () => {
    const config = fullSweepConfig();
    expect(config.decode).toMatchObject({ thinking: true, temperature: 0.7, contextTokens: 16384, maxTokens: 400 });
    expect(config.decode.concurrencies).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32]);
    expect(config.prefill.contextSizes).toEqual([1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]);
    expect(config.quality).toMatchObject({ profile: "full", longSizes: [131072] });
    expect(qualityCategories("full")).toEqual(expect.arrayContaining(["long", "math500", "tokenizer", "fidelity", "divergence"]));
    expect(qualityCategories("default")).not.toContain("long");
    expect(config.toolEval.template).toBe("regular-hard");
    expect(toolEvalOptions("regular-hard")).toEqual({ hardmode: true, seed: 42 });
    expect(toolEvalOptions("regular")).toEqual({ seed: 42 });
    expect(toolEvalOptions("short")).toEqual({ short: true, seed: 42 });
    expect(toolEvalOptions("hard")).toEqual({ "hardmode-only": true, seed: 42 });
  });

  it("formats section times in hours when a stage runs long", () => {
    expect(formatSectionDuration(3_725_000)).toBe("1h 2m");
    expect(formatSectionDuration(65_000)).toBe("1m 5s");
    expect(formatSectionDuration(4_400)).toBe("4s");
    expect(formatSectionDuration(null)).toBe("—");
  });

  it("keeps one row when a started campaign and an adopted copy share a decode job", () => {
    const started = createCampaign({ sparkId: "s", port: 8000, modelId: "Qwen3.8-Flash-Next", config: fullSweepConfig(), now: 1 });
    started.status = "completed";
    started.stage = "tool-eval";
    started.jobs = { decode: "d1", prefill: "p1", quality: "q1", toolEval: "t1" };
    const adopted = { ...started, id: "camp-adopted-d1" };
    const kept = dedupeCampaigns([adopted, started]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(started.id);
  });

  it("names a campaign with the engine and its version", () => {
    expect(engineLabel("tensorfold", "zig-db28187")).toBe("TensorFold zig-db28187");
    expect(engineLabel("vLLM 0.30.0", "0.30.0")).toBe("vLLM 0.30.0");
    expect(engineLabel("tensorfold", null)).toBe("TensorFold");
    const run = createCampaign({ sparkId: "s", port: 8000, modelId: "Qwen3.8-Flash-Next", engine: "TensorFold zig-db28187", config: fullSweepConfig(), now: 1 });
    expect(campaignTitle(run)).toBe("Qwen3.8-Flash-Next · TensorFold zig-db28187");
    expect(registryEngine([
      { endpoint: "http://spark.local:8000/v1", runtime: "exited", engine: "vLLM 0.30.0" },
      { endpoint: "http://spark.local:8000/v1", runtime: "running", engine: "TensorFold zig-db28187" },
    ], 8000)).toBe("TensorFold zig-db28187");
    expect(campaignEngine("TensorFold zig-db28187", { backend: "vllm", engineVersion: "0.30.0" })).toBe("vLLM 0.30.0");
    expect(campaignEngine(null, { backend: "vllm", engineVersion: "0.30.0" })).toBe("vLLM 0.30.0");
    expect(campaignEngine("TensorFold zig-db28187", { backend: "tensorfold", engineVersion: null })).toBe("TensorFold zig-db28187");
  });

  it("does not pair a full sweep with a shorter custom run", () => {
    const full = fullSweepConfig();
    const shorter = {
      ...full,
      decode: { ...full.decode, concurrencies: [1, 2] },
      quality: { profile: "default" as const },
    };
    expect(campaignsComparable(full, shorter)).toBe(false);
    expect(campaignDiffs(full, shorter)).toEqual(["decode.concurrencies", "quality.profile"]);
  });

  it("reads the four headline numbers from the child jobs", () => {
    const headlines = headlinesFromJobs({
      decode: { results: [
        { promptType: "prose", concurrency: 1, aggregateDecodeTps: 40 },
        { promptType: "code", concurrency: 1, aggregateDecodeTps: 60 },
        { promptType: "prose", concurrency: 2, aggregateDecodeTps: 70 },
      ] },
      prefill: { results: [
        { targetTokens: 4096, prefillTps: 2000 },
        { targetTokens: 16384, prefillTps: 800 },
      ] },
      quality: { results: { overallPct: 81.5 } },
      tool: { summary: { finalScore: 66 } },
    });
    expect(headlines.decodeAgg).toBe(50);
    expect(headlines.prefillTps).toBe(800);
    expect(headlines.qualityPct).toBe(81.5);
    expect(headlines.toolScore).toBe(66);
  });
});

describe("campaign runner", () => {
  const run = createCampaign({ sparkId: "s", port: 8000, modelId: "m", config: fullSweepConfig(), now: 1 });

  it("does not start when a benchmark is already running", async () => {
    let starts = 0;
    const done = await runCampaign(run, client({
      busy: async () => "decode",
      startDecode: async () => { starts += 1; return "d"; },
    }), { sleep: async () => {}, isStopped: () => false, onUpdate: () => {} });
    expect(done.status).toBe("failed");
    expect(done.error).toBe("busy:decode");
    expect(starts).toBe(0);
  });

  it("runs the four benchmarks in order and keeps their ids", async () => {
    const order: string[] = [];
    const done = await runCampaign(run, client({
      startDecode: async () => { order.push("decode"); return "d1"; },
      startPrefill: async () => { order.push("prefill"); return "p1"; },
      startQuality: async () => { order.push("quality"); return "q1"; },
      startToolEval: async () => { order.push("tool-eval"); return "t1"; },
    }), { sleep: async () => {}, isStopped: () => false, onUpdate: () => {} });
    expect(order).toEqual(["decode", "prefill", "quality", "tool-eval"]);
    expect(done.status).toBe("completed");
    expect(done.jobs).toEqual({ decode: "d1", prefill: "p1", quality: "q1", toolEval: "t1" });
    expect(done.headlines.decodeAgg).toBe(40);
  });

  it("stops the campaign when a stage fails and does not start the next one", async () => {
    let prefill = 0;
    const done = await runCampaign(run, client({
      pollDecode: async () => ({ status: "failed", error: "decode broke", job: null }),
      startPrefill: async () => { prefill += 1; return "p"; },
    }), { sleep: async () => {}, isStopped: () => false, onUpdate: () => {} });
    expect(done.status).toBe("failed");
    expect(done.error).toBe("decode broke");
    expect(prefill).toBe(0);
    expect(done.jobs.decode).toBe("d1");
  });

  it("leaves the current benchmark running when the campaign is stopped", async () => {
    let stop = false;
    const done = await runCampaign(run, client({
      startDecode: async () => {
        stop = true;
        return "d1";
      },
      pollDecode: async () => ({ status: "running", job: null }),
    }), { sleep: async () => {}, pollMs: 0, isStopped: () => stop, onUpdate: () => {} });
    expect(done.status).toBe("stopped");
    expect(done.jobs.decode).toBe("d1");
    expect(done.jobs.prefill).toBeUndefined();
  });
});
