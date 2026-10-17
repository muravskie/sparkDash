import { describe, expect, it } from "vitest";
import {
  BIN_COUNT,
  chartMaximum,
  displayValue,
  histogram16,
  linearScale,
  MIN_GAP_MS,
  monotonePath,
  plotPoints,
  type ChartSample,
} from "./chartGeometry";

describe("linear scale", () => {
  it("maps the domain onto the range", () => {
    const scale = linearScale([10, 20], [0, 100]);
    expect(scale(10)).toBe(0);
    expect(scale(20)).toBe(100);
    expect(scale(15)).toBe(50);
  });

  it("sits in the middle of a zero-width domain", () => {
    expect(linearScale([5, 5], [0, 10])(5)).toBe(5);
  });

  it("rounds a plain series up to a 1-2-5 maximum and keeps ratios at 100", () => {
    expect(chartMaximum([42], "")).toBe(50);
    expect(chartMaximum([8], "tok/s")).toBe(10);
    expect(chartMaximum([0, 0], "")).toBe(1);
    expect(chartMaximum([1], "requests")).toBe(2);
    expect(chartMaximum([0.2, 1.4], "ratio")).toBe(100);
    expect(displayValue(0.25, "ratio")).toBe(25);
    expect(displayValue(12, "tok/s")).toBe(12);
    expect(displayValue(null, "tok/s")).toBeNull();
  });
});

describe("monotone path gaps", () => {
  const x = linearScale([0, 40_000], [0, 200]);
  const y = linearScale([0, 10], [100, 0]);

  function cadence(gapAt: number, gapMs: number): ChartSample[] {
    const samples: ChartSample[] = [];
    let at = 0;
    for (let i = 0; i < 12; i++) {
      if (i === 6) at += gapMs;
      else if (i > 0) at += 2_000;
      samples.push({ at, value: i === gapAt ? null : 4 });
    }
    return samples;
  }

  it("draws one cubic through a steady cadence", () => {
    const path = monotonePath(plotPoints(cadence(-1, 2_000), x, y, ""));
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).toContain("C");
    expect(path).not.toContain("L");
  });

  it("breaks the curve when the interval is at least 15s and more than 3× the median", () => {
    const samples = cadence(-1, MIN_GAP_MS);
    const points = plotPoints(samples, x, y, "");
    expect(points.filter((point) => point == null)).toHaveLength(1);
    expect(monotonePath(points).match(/M/g)).toHaveLength(2);
  });

  it("keeps the curve joined under 15s, and when the interval is not more than 3× the median", () => {
    expect(monotonePath(plotPoints(cadence(-1, MIN_GAP_MS - 1), x, y, "")).match(/M/g)).toHaveLength(1);
    // Every interval is 20s, so the median is 20s and 3× that is longer than the hole.
    const slow = Array.from({ length: 6 }, (_, i) => ({ at: i * 20_000, value: 4 }));
    expect(monotonePath(plotPoints(slow, x, y, "")).match(/M/g)).toHaveLength(1);
  });

  it("opens a gap for a missing value without inventing a bridge", () => {
    const samples = cadence(6, 2_000);
    const path = monotonePath(plotPoints(samples, x, y, ""));
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("stays a straight cubic when the samples are colinear", () => {
    expect(monotonePath([{ x: 0, y: 0 }, { x: 3, y: 3 }])).toBe("M0 0C1 1 2 2 3 3");
  });
});

describe("16-bin mean highlighting", () => {
  it("uses 16 bins and marks the bin that contains the mean, even when that bin is empty", () => {
    const values = [0, 0, 0, 0, 0, 15, 15, 15, 15, 15];
    const bins = histogram16(values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

    expect(bins.binCount).toBe(BIN_COUNT);
    expect(bins.counts).toHaveLength(16);
    expect(bins.counts.reduce((sum, count) => sum + count, 0)).toBe(values.length);
    expect(bins.mean).toBeCloseTo(mean);
    expect(bins.counts[bins.meanBin]).toBe(0);

    const low = bins.binStart + bins.meanBin * bins.binWidth;
    const high = low + bins.binWidth;
    expect(mean).toBeGreaterThanOrEqual(low);
    expect(mean).toBeLessThan(high);
    expect(bins.meanBin).toBe(Math.floor((mean - bins.binStart) / bins.binWidth));
  });

  it("puts a flat series in the bin that holds the mean, and the top value in the last bin", () => {
    const flat = histogram16([40, 40, 40]);
    expect(flat.counts[flat.meanBin]).toBe(3);
    expect(flat.meanBin).toBeGreaterThanOrEqual(0);
    expect(flat.meanBin).toBeLessThan(16);

    const topped = histogram16([0, 16]);
    expect(topped.counts).toHaveLength(16);
    expect(topped.counts[15]).toBe(1);
    expect(topped.meanBin).toBeGreaterThanOrEqual(0);
  });

  it("does not highlight a bin when every sample is missing", () => {
    const bins = histogram16([]);
    expect(bins.counts).toHaveLength(16);
    expect(bins.mean).toBeNull();
    expect(bins.meanBin).toBe(-1);
  });
});
