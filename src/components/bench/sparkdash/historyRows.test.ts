import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../../api/types";
import { decodeHistoryRow, filterHistoryByPort, prefillHistoryRow, qualityHistoryRow } from "./historyRows";

const level = (concurrency: number, agg: number, mean: number) =>
  ({
    concurrency,
    aggregateDecodeTps: agg,
    meanDecodeTps: mean,
    totalDecodeTokens: 100,
    totalCompletionTokens: 100,
    model: "m",
  }) as unknown as DecodeBenchJob["results"][number];

describe("history rows", () => {
  it("decode picks the peak aggregate level", () => {
    const job = {
      benchId: "d1",
      startedAt: 1,
      status: "completed",
      config: { concurrencies: [1, 4], modelId: "qwen" },
      results: [level(1, 30, 30), level(4, 90, 25)],
    } as unknown as DecodeBenchJob;
    const row = decodeHistoryRow(job);
    expect(row.headline).toBe("90.0 tok/s");
    expect(row.detail).toBe("peak at ×4 · 30.0/stream at ×1");
    expect(row.label).toBe("×1, 4");
    expect(row.model).toBe("qwen");
  });

  it("lists prompt types on the decode history label, including a single older promptType", () => {
    const multi = decodeHistoryRow({
      benchId: "d3",
      startedAt: 1,
      status: "completed",
      config: { concurrencies: [1, 2], modelId: "qwen", promptTypes: ["code", "prose"], promptType: "prose" },
      results: [level(1, 30, 30)],
    } as unknown as DecodeBenchJob);
    expect(multi.label).toBe("Prose, Code · ×1, 2");
    const legacy = decodeHistoryRow({
      benchId: "d4",
      startedAt: 1,
      status: "completed",
      config: { concurrencies: [1], modelId: "qwen", promptType: "json" },
      results: [level(1, 10, 10)],
    } as unknown as DecodeBenchJob);
    expect(legacy.label).toBe("JSON · ×1");
  });

  it("decode shows a dash when nothing decoded", () => {
    const job = {
      benchId: "d2",
      startedAt: 1,
      status: "failed",
      config: { concurrencies: [1], modelId: null },
      results: [{ ...level(1, 0, 0), totalDecodeTokens: 0, totalCompletionTokens: 0, model: null }],
    } as unknown as DecodeBenchJob;
    expect(decodeHistoryRow(job).headline).toBe("—");
  });

  it("prefill picks the fastest size", () => {
    const job = {
      benchId: "p1",
      startedAt: 1,
      status: "completed",
      config: { contextSizes: [4096, 16384], modelId: "m" },
      results: [
        { targetTokens: 4096, prefillTps: 1000, model: "m" },
        { targetTokens: 16384, prefillTps: 800, model: "m" },
      ],
    } as unknown as PrefillBenchJob;
    const row = prefillHistoryRow(job);
    expect(row.headline).toBe("1000.0 tok/s");
    expect(row.detail).toBe("best at 4k");
  });

  it("quality reports the overall score and label", () => {
    const job = {
      benchId: "q1",
      startedAt: 1,
      status: "completed",
      config: { label: "fp4 KV", modelId: "m" },
      results: { overallPct: 71.234, categories: { qa: {}, code: {} } },
    } as unknown as QualityBenchJob;
    const row = qualityHistoryRow(job);
    expect(row.headline).toBe("71.2%");
    expect(row.label).toBe("fp4 KV");
    expect(row.detail).toBe("2 categories");
    expect(row.port).toBeNull();
  });

  it("keeps the port on a quality row and can narrow to one port", () => {
    const job = {
      benchId: "q2",
      startedAt: 1,
      status: "completed",
      config: { label: "port", modelId: "m", port: 8001 },
      results: { overallPct: 1, categories: {} },
    } as unknown as QualityBenchJob;
    expect(qualityHistoryRow(job).port).toBe(8001);
    const rows = [
      { config: { port: 8000 } },
      { config: { port: 8001 } },
      { config: { port: 8001 } },
    ];
    expect(filterHistoryByPort(rows, "all", 8000)).toHaveLength(3);
    expect(filterHistoryByPort(rows, "port", 8001)).toHaveLength(2);
  });
});
