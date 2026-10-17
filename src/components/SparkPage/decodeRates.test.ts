import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, DecodeBenchLevelResult } from "../../api/types";
import {
  aggregateTps,
  groupDecodeResults,
  overlapRatio,
  streamTps,
  streamWindowTitle,
  streamsDidNotOverlap,
  sumTps,
} from "./decodeRates";

function level(over: Partial<DecodeBenchLevelResult> = {}): DecodeBenchLevelResult {
  return {
    concurrency: 2,
    streamsOk: 2,
    streamsFailed: 0,
    meanDecodeTps: 40,
    medianDecodeTps: 40,
    minDecodeTps: 40,
    maxDecodeTps: 40,
    meanTtftMs: 200,
    medianTtftMs: 200,
    aggregateDecodeTps: 80,
    meanPrefillTps: 0,
    medianPrefillTps: 0,
    aggregatePrefillTps: 0,
    totalPrefillTokens: 0,
    totalDecodeTokens: 100,
    totalCompletionTokens: 100,
    durationMs: 1000,
    error: null,
    streams: [
      { index: 0, ttftMs: 100, ttftContentMs: 100, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 1000, error: null, tFirst: 1000, tLast: 2000 },
      { index: 1, ttftMs: 120, ttftContentMs: 120, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 1000, error: null, tFirst: 1100, tLast: 2100 },
    ],
    model: "m",
    ...over,
  };
}

describe("decode row rates", () => {
  it("reports stream, sum, and the stored aggregate", () => {
    const r = level();
    expect(streamTps(r)).toBe(40);
    expect(sumTps(r)).toBe(80);
    expect(aggregateTps(r)).toBe(80);
    expect(overlapRatio(r)).toBe(1);
    expect(streamsDidNotOverlap(r)).toBe(false);
  });

  it("says streams did not overlap when overlap is clearly under 1 and TTFT is spread", () => {
    const spread = level({
      aggregateDecodeTps: 40,
      streams: [
        { index: 0, ttftMs: 100, ttftContentMs: null, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 1000, error: null, tFirst: 0, tLast: 5000 },
        { index: 1, ttftMs: 2000, ttftContentMs: null, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 3000, error: null, tFirst: 1900, tLast: 5000 },
      ],
    });
    expect(overlapRatio(spread)).toBe(0.5);
    expect(streamsDidNotOverlap(spread)).toBe(true);
    expect(streamWindowTitle(spread)).toContain("#0 +0ms → +5000ms");
    expect(streamWindowTitle(spread)).toContain("#1 +1900ms → +5000ms");
  });

  it("stays quiet when overlap is close to 1 or TTFT is tight", () => {
    expect(streamsDidNotOverlap(level({ aggregateDecodeTps: 76 }))).toBe(false);
    const tight = level({
      aggregateDecodeTps: 40,
      streams: [
        { index: 0, ttftMs: 100, ttftContentMs: null, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 1000, error: null },
        { index: 1, ttftMs: 140, ttftContentMs: null, reasoningChunks: 0, decodeTps: 40, decodeTokens: 50, completionTokens: 50, prefillTps: 0, prefillTokens: 0, totalMs: 1000, error: null },
      ],
    });
    expect(streamsDidNotOverlap(tight)).toBe(false);
    expect(overlapRatio(level({ streamsOk: 0, meanDecodeTps: 40, aggregateDecodeTps: 10 }))).toBeNull();
  });

  it("groups multi-type results by type and leaves a single type flat", () => {
    const job = {
      config: { promptTypes: ["structured", "code"], promptType: "structured" },
      results: [
        level({ concurrency: 1, promptType: "structured" }),
        level({ concurrency: 1, promptType: "code" }),
        level({ concurrency: 2, promptType: "structured" }),
      ],
    } as unknown as DecodeBenchJob;
    const groups = groupDecodeResults(job);
    expect(groups.map((g) => g.label)).toEqual(["Structured", "Code"]);
    expect(groups[0].rows.map((r) => r.concurrency)).toEqual([1, 2]);
    const single = groupDecodeResults({
      config: { promptType: "prose" },
      results: [level()],
    } as unknown as DecodeBenchJob);
    expect(single).toHaveLength(1);
    expect(single[0].label).toBeNull();
  });
});
