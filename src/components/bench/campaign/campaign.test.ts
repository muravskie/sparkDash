import { describe, expect, it } from "vitest";
import {
  campaignDiffs,
  campaignsComparable,
  createCampaign,
  detailedConfig,
  headlineConfig,
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
  it("keeps the headline on the short quality suite and 16k prefill", () => {
    const config = headlineConfig();
    expect(config.decode).toMatchObject({ thinking: false, temperature: 0, contextTokens: 16384, concurrencies: [1, 2], maxTokens: 256 });
    expect(config.prefill.contextSizes).toEqual([16384]);
    expect(config.quality.profile).toBe("default");
    expect(qualityCategories("default")).not.toContain("long");
    expect(config.toolEval.template).toBe("regular");
    expect(toolEvalOptions("regular")).toEqual({ seed: 42 });
    expect(toolEvalOptions("short")).toEqual({ short: true, seed: 42 });
    expect(toolEvalOptions("hard")).toEqual({ "hardmode-only": true, seed: 42 });
  });

  it("adds the steps around 16k on the detailed preset", () => {
    const config = detailedConfig();
    expect(config.decode.concurrencies).toEqual([1, 2, 4]);
    expect(config.prefill.contextSizes).toEqual([4096, 16384, 32768]);
    expect(qualityCategories("default-16k")).toContain("long");
  });

  it("refuses to pair a headline with a detailed run", () => {
    expect(campaignsComparable(headlineConfig(), detailedConfig())).toBe(false);
    expect(campaignDiffs(headlineConfig(), detailedConfig())).toEqual([
      "decode.concurrencies",
      "decode.maxTokens",
      "prefill.context",
      "quality.profile",
    ]);
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
  const run = createCampaign({ sparkId: "s", port: 8000, modelId: "m", config: headlineConfig(), now: 1 });

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
