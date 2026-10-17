/**
 * Decode and prefill history keep the last 30 runs, including the slice at load.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import os from "os";
import path from "path";
import fs from "fs";
import { DecodeBenchManager } from "../DecodeBench.js";
import { PrefillBenchManager } from "../PrefillBench.js";

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-hist-"));
}

function decodeJob(id) {
  return {
    benchId: id,
    sparkId: "s1",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: { port: 1, concurrencies: [1], maxTokens: 400, promptType: "structured", promptTypes: ["structured"] },
    progress: { currentConcurrency: null, completedLevels: 1, totalLevels: 1, message: "Done" },
    results: [],
    error: null,
  };
}

function prefillJob(id) {
  return {
    benchId: id,
    sparkId: "s1",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: { port: 1, contextSizes: [1024] },
    progress: { currentContext: null, completedLevels: 1, totalLevels: 1, message: "Done" },
    results: [],
    error: null,
  };
}

async function until(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out");
}

test("decode history load and push keep 30", () => {
  const root = dir();
  const hist = path.join(root, "hist.json");
  const jobs = Array.from({ length: 40 }, (_, i) => decodeJob(`b${i}`));
  fs.writeFileSync(hist, JSON.stringify({ s1: jobs }));
  const mgr = new DecodeBenchManager(hist, path.join(root, "active.json"));
  assert.equal(mgr.getHistory("s1").length, 30);
  assert.equal(mgr.getHistory("s1")[0].benchId, "b0");
  assert.equal(mgr.getHistory("s1").at(-1).benchId, "b29");
  mgr._pushHistory({ ...decodeJob("new"), sparkId: "s1" });
  assert.equal(mgr.getHistory("s1").length, 30);
  assert.equal(mgr.getHistory("s1")[0].benchId, "new");
  assert.equal(mgr.getHistory("s1").some((j) => j.benchId === "b29"), false);
});

test("prefill history load and push keep 30", () => {
  const root = dir();
  const hist = path.join(root, "hist.json");
  const jobs = Array.from({ length: 40 }, (_, i) => prefillJob(`p${i}`));
  fs.writeFileSync(hist, JSON.stringify({ s1: jobs }));
  const mgr = new PrefillBenchManager(hist, path.join(root, "active.json"));
  assert.equal(mgr.getHistory("s1").length, 30);
  assert.equal(mgr.getHistory("s1")[0].benchId, "p0");
  assert.equal(mgr.getHistory("s1").at(-1).benchId, "p29");
  mgr._pushHistory({ ...prefillJob("new"), sparkId: "s1" });
  assert.equal(mgr.getHistory("s1").length, 30);
  assert.equal(mgr.getHistory("s1")[0].benchId, "new");
});

test("decode start stores promptTypes in catalog order and still accepts promptType", async () => {
  const root = dir();
  const mgr = new DecodeBenchManager(path.join(root, "hist.json"), path.join(root, "active.json"));
  assert.throws(
    () =>
      mgr.start({
        sparkId: "s1",
        lanIp: "127.0.0.1",
        port: 9,
        modelId: "m",
        concurrencies: [1],
        promptTypes: ["nope"],
      }),
    /at least one prompt type/i
  );

  const job = mgr.start({
    sparkId: "s1",
    lanIp: "127.0.0.1",
    port: 9,
    modelId: "m",
    concurrencies: [2, 1],
    promptTypes: ["json", "prose", "nope", "prose"],
    resolveTarget: async () => {
      throw new Error("stop");
    },
  });
  assert.deepEqual(job.config.promptTypes, ["prose", "json"]);
  assert.equal(job.config.promptType, "prose");
  assert.equal(job.progress.totalLevels, 4);
  await until(() => mgr.getJob(job.benchId)?.status !== "running");

  const legacy = mgr.start({
    sparkId: "s2",
    lanIp: "127.0.0.1",
    port: 9,
    modelId: "m",
    concurrencies: [1],
    promptType: "code",
    resolveTarget: async () => {
      throw new Error("stop");
    },
  });
  assert.deepEqual(legacy.config.promptTypes, ["code"]);
  assert.equal(legacy.config.promptType, "code");
  await until(() => mgr.getJob(legacy.benchId)?.status !== "running");
});
