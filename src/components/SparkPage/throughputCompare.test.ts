import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, PrefillBenchJob } from "../../api/types";
import {
  checkDecodeComparable,
  checkPrefillComparable,
  compareDecodeRuns,
  comparePrefillRuns,
  formatTokDelta,
  tokDelta,
} from "./throughputCompare";

function decode(over: Partial<DecodeBenchJob> & { promptType?: string; promptTypes?: string[] } = {}): DecodeBenchJob {
  const { promptType = "structured", promptTypes, ...rest } = over;
  return {
    benchId: "a",
    sparkId: "s",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: {
      port: 1,
      modelId: "m",
      concurrencies: [1, 2],
      maxTokens: 400,
      promptType: promptType as DecodeBenchJob["config"]["promptType"],
      ...(promptTypes ? { promptTypes: promptTypes as NonNullable<DecodeBenchJob["config"]["promptTypes"]> } : {}),
    },
    progress: { currentConcurrency: null, completedLevels: 1, totalLevels: 1, message: "Done" },
    results: [
      { concurrency: 1, aggregateDecodeTps: 30, meanDecodeTps: 30, totalDecodeTokens: 10, totalCompletionTokens: 10, model: "m" },
      { concurrency: 2, aggregateDecodeTps: 50, meanDecodeTps: 25, totalDecodeTokens: 10, totalCompletionTokens: 10, model: "m" },
    ],
    error: null,
    durationMs: 1,
    ...rest,
  } as unknown as DecodeBenchJob;
}

function prefill(sizes: number[], rates: number[]): PrefillBenchJob {
  return {
    config: { contextSizes: sizes, modelId: "m", port: 1 },
    results: sizes.map((targetTokens, i) => ({ targetTokens, prefillTps: rates[i] ?? 0, error: rates[i] > 0 ? null : "failed" })),
  } as unknown as PrefillBenchJob;
}

describe("throughput compare", () => {
  it("pairs decode runs on model and prompt type and shows both rates with a delta", () => {
    const a = decode();
    const b = decode({
      results: [
        { concurrency: 1, aggregateDecodeTps: 20, meanDecodeTps: 20, totalDecodeTokens: 10, totalCompletionTokens: 10 },
        { concurrency: 2, aggregateDecodeTps: 40, meanDecodeTps: 22, totalDecodeTokens: 10, totalCompletionTokens: 10 },
      ] as DecodeBenchJob["results"],
    });
    expect(checkDecodeComparable(a, b).ok).toBe(true);
    const rows = compareDecodeRuns(a, b);
    expect(rows.map((r) => r.level)).toEqual(["×1", "×2"]);
    expect(rows[0]).toMatchObject({ primaryA: 30, primaryB: 20, secondaryA: 30, secondaryB: 20 });
    expect(tokDelta(rows[1].primaryA, rows[1].primaryB)).toBe(10);
    expect(formatTokDelta(10)).toBe("+10.0");
    expect(formatTokDelta(-2)).toBe("-2.0");
  });

  it("treats an older promptType job as the same setup as promptTypes of that one type", () => {
    const a = decode();
    const b = decode({ promptTypes: ["structured"] });
    expect(checkDecodeComparable(a, b).ok).toBe(true);
    expect(compareDecodeRuns(a, b)).toHaveLength(2);
  });

  it("refuses a mismatched decode pair and does not invent a score", () => {
    const model = checkDecodeComparable(decode(), decode({ config: { modelId: "other" } } as Partial<DecodeBenchJob>));
    expect(model.ok).toBe(false);
    expect(model.reason).toMatch(/Different models/);
    expect(compareDecodeRuns(decode(), decode({ config: { modelId: "other" } } as Partial<DecodeBenchJob>))).toEqual([]);

    const types = checkDecodeComparable(decode(), decode({ promptTypes: ["prose", "code"] }));
    expect(types.ok).toBe(false);
    expect(types.reason).toMatch(/Different prompt types/);
    expect(compareDecodeRuns(decode(), decode({ promptTypes: ["prose"] }))).toEqual([]);
  });

  it("leaves a missing concurrency blank", () => {
    const a = decode();
    const b = decode({
      results: [{ concurrency: 1, aggregateDecodeTps: 10, meanDecodeTps: 10, totalDecodeTokens: 4, totalCompletionTokens: 4 }] as DecodeBenchJob["results"],
    });
    const rows = compareDecodeRuns(a, b);
    expect(rows[1].primaryB).toBeNull();
    expect(tokDelta(rows[1].primaryA, rows[1].primaryB)).toBeNull();
    expect(formatTokDelta(null)).toBe("—");
  });

  it("pairs prefill runs only when the context sizes match", () => {
    const a = prefill([8192, 4096], [1000, 800]);
    const b = prefill([4096, 8192], [900, 700]);
    expect(checkPrefillComparable(a, b).ok).toBe(true);
    const rows = comparePrefillRuns(a, b);
    expect(rows.map((r) => [r.level, r.primaryA, r.primaryB])).toEqual([
      ["4k", 800, 900],
      ["8k", 1000, 700],
    ]);
    expect(rows[0].secondaryA).toBeNull();

    const mismatch = checkPrefillComparable(a, prefill([4096], [1]));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toMatch(/Different context sizes/);
    expect(comparePrefillRuns(a, prefill([4096, 16384], [1, 1]))).toEqual([]);
  });

  it("does not turn a failed prefill size into a zero score", () => {
    const rows = comparePrefillRuns(prefill([4096], [0]), prefill([4096], [500]));
    expect(rows[0].primaryA).toBeNull();
    expect(rows[0].primaryB).toBe(500);
  });
});
