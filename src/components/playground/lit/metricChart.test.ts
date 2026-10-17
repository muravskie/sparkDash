import { afterEach, describe, expect, it } from "vitest";
import { linear, monotonePath } from "./chartBase";
import {
  BIN_COUNT,
  chartMaximum,
  chartValue,
  gapLimitMs,
  generationSpanMean,
  generationSpanSamples,
  histogram16,
  insertTimeGaps,
  MetricChart,
  type ChartSample,
} from "./metricChart";
import { formatMetric, MetricsStrip, recordProbeRing, resetProbeRings } from "./metricsStrip";

afterEach(() => {
  resetProbeRings();
});

describe("linear scale", () => {
  it("maps the domain onto the range and inverts", () => {
    const scale = linear([10, 20], [0, 100]);
    expect(scale(10)).toBe(0);
    expect(scale(20)).toBe(100);
    expect(scale(15)).toBe(50);
    expect(scale.invert(0)).toBe(10);
    expect(scale.invert(100)).toBe(20);
    expect(scale.invert(50)).toBe(15);
  });

  it("keeps a zero-width domain invertible", () => {
    const scale = linear([5, 5], [0, 10]);
    expect(scale(5)).toBe(0);
    expect(scale.invert(0)).toBe(5);
    expect(scale.invert(10)).toBe(6);
  });

  it("draws ratios as percent on a 0–100 axis", () => {
    expect(chartValue(0.25, "ratio")).toBe(25);
    expect(chartValue(12, "tokens/s")).toBe(12);
    expect(chartValue(null, "tokens/s")).toBeNull();
    expect(chartMaximum([0.2, 1.4], "ratio")).toBe(100);
    expect(chartMaximum([42], "")).toBe(50);
    expect(chartMaximum([0, 0], "tokens/s")).toBe(1);
  });
});

describe("monotone path gaps", () => {
  const x = linear([0, 40_000], [0, 200]);
  const y = linear([0, 10], [100, 0]);

  function series(gapMs: number, holeAt = -1): ChartSample[] {
    const samples: ChartSample[] = [];
    let at = 0;
    for (let i = 0; i < 8; i++) {
      if (i > 0) at += i === 4 ? gapMs : 2_000;
      samples.push({ at, value: i === holeAt ? null : 4 });
    }
    return samples;
  }

  function pathFor(samples: ChartSample[]): string {
    const points = samples.map((sample) => (sample.value == null ? null : { x: x(sample.at), y: y(sample.value) }));
    return monotonePath(insertTimeGaps(samples, points));
  }

  it("draws one curve through a steady cadence, and a line for two points", () => {
    const path = pathFor(series(2_000));
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).toContain("C");
    expect(monotonePath([{ x: 0, y: 0 }, { x: 3, y: 3 }])).toBe("M0,0 L3,3");
    expect(monotonePath([{ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 6, y: 6 }])).toBe("M0,0 C1,1 2,2 3,3 C4,4 5,5 6,6");
  });

  it("breaks the curve when the interval is longer than 15s and longer than 3× the median", () => {
    const broken = series(16_000);
    expect(gapLimitMs(broken)).toBe(15_000);
    expect(pathFor(broken).match(/M/g)).toHaveLength(2);
    expect(pathFor(series(15_000)).match(/M/g)).toHaveLength(1);
    const slow = Array.from({ length: 6 }, (_, i) => ({ at: i * 20_000, value: 4 }));
    expect(pathFor(slow).match(/M/g)).toHaveLength(1);
  });

  it("opens a gap for a missing value without bridging it", () => {
    expect(pathFor(series(2_000, 3)).match(/M/g)).toHaveLength(2);
    expect(monotonePath([{ x: 0, y: 1 }, null, { x: 4, y: 2 }]).match(/M/g)).toHaveLength(2);
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
    expect(mean).toBeGreaterThanOrEqual(low);
    expect(mean).toBeLessThan(low + bins.binWidth);
  });

  it("puts a flat series in the bin that holds the mean, and the top value in the last bin", () => {
    const flat = histogram16([40, 40, 40]);
    expect(flat.counts[flat.meanBin]).toBe(3);
    expect(flat.meanBin).toBeGreaterThanOrEqual(0);
    expect(flat.meanBin).toBeLessThan(16);

    const topped = histogram16([0, 16]);
    expect(topped.counts[15]).toBe(1);
    expect(topped.mean).toBeCloseTo(8);
  });

  it("does not highlight a bin when every sample is missing", () => {
    const bins = histogram16([]);
    expect(bins.counts).toHaveLength(16);
    expect(bins.mean).toBeNull();
    expect(bins.meanBin).toBe(-1);
  });

  it("highlights the mean bin on the overlay chart", async () => {
    const chart = document.createElement("spark-metric-chart") as MetricChart;
    chart.label = "Generation throughput";
    chart.unit = "tokens/s";
    chart.mode = "overlay";
    chart.end = 4_000;
    chart.windowSeconds = 300;
    chart.samples = [0, 0, 10, 10].map((value, index) => ({ at: index * 1_000, value }));
    document.body.append(chart);
    await chart.updateComplete;
    await chart.updateComplete;

    expect(chart.querySelectorAll(".histogram-bar")).toHaveLength(16);
    expect(chart.querySelectorAll(".histogram-bar.mean-bin")).toHaveLength(1);
    expect(chart.querySelector(".histogram-mean-bin")).not.toBeNull();
    expect(chart.querySelector(".histogram-mean-line")).not.toBeNull();
    const label = chart.querySelector(".metric-chart")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("16 vertical bins");
    expect(label).toContain("time on the top axis");
    expect(label).toContain("mean");
    expect(label).toContain("highlighted");
    const titles = [...chart.querySelectorAll(".chart-axis-title")].map((node) => node.textContent);
    expect(titles).toContain("Time");
    expect(titles).toContain("Samples / bin");
  });
});

describe("generation span mean", () => {
  const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

  it("drops zeros, ignores samples outside the reply, and does not copy a status-line rate", async () => {
    const first = 10_000;
    const end = 20_000;
    const statusLine = 87.6;
    const samples = [
      ...Array.from({ length: 8 }, (_, index) => ({ at: index * 1_000, value: 0 })),
      { at: 9_000, value: 200 },
      { at: first, value: 80 },
      { at: 12_000, value: 0 },
      { at: 15_000, value: 91 },
      { at: end, value: 100 },
      ...Array.from({ length: 8 }, (_, index) => ({ at: end + (index + 1) * 1_000, value: 0 })),
    ];
    const span = { firstTokenAt: first, endAt: end, samples };
    const values = generationSpanSamples(span).map((sample) => sample.value);
    const mean = generationSpanMean(span);

    expect(values).toEqual([80, 91, 100]);
    expect(mean).toBeCloseTo((80 + 91 + 100) / 3);
    expect(mean).not.toBe(statusLine);
    expect(generationSpanMean({
      firstTokenAt: first,
      endAt: end,
      samples: [...samples, { at: -20_000, value: 0 }, { at: first - 1, value: 50 }, { at: end + 1, value: 0 }, { at: end + 120_000, value: statusLine }],
    })).toBe(mean);
    expect(generationSpanMean({ firstTokenAt: null, endAt: end, samples })).toBeNull();
    expect(generationSpanMean({ firstTokenAt: first, endAt: 15_000, samples })).toBeCloseTo((80 + 91) / 2);

    const bins = histogram16(values, "tokens/s");
    const binsAgain = histogram16(generationSpanSamples({
      firstTokenAt: first,
      endAt: end,
      samples: [...samples, { at: 1, value: 0 }, { at: end + 5_000, value: 0 }, { at: end + 6_000, value: 12 }],
    }).map((sample) => sample.value), "tokens/s");
    expect(bins.counts.reduce((sum, count) => sum + count, 0)).toBe(values.length);
    expect(binsAgain.counts).toEqual(bins.counts);
    expect(binsAgain.mean).toBe(bins.mean);
    expect(binsAgain.meanBin).toBe(bins.meanBin);
    expect(bins.binStart).toBeGreaterThan(0);
    const low = bins.binStart + bins.meanBin * bins.binWidth;
    expect(bins.mean).toBeGreaterThanOrEqual(low);
    expect(bins.mean).toBeLessThan(low + bins.binWidth);

    expect(formatMetric(91, "tokens/s")).toBe((91).toLocaleString(undefined, oneDecimal));
    expect(formatMetric(91.5, "tokens/s")).toBe((91.5).toLocaleString(undefined, oneDecimal));
    expect(formatMetric(38.4, "tokens/s")).toBe((38.4).toLocaleString(undefined, oneDecimal));
    expect(formatMetric(91, "tokens/s")).toMatch(/[.,]\d$/);
    expect(formatMetric(mean!, "tokens/s")).toMatch(/[.,]\d$/);
    expect(formatMetric(91, "tokens/s")).not.toBe((91).toLocaleString(undefined, { maximumFractionDigits: 1 }));

    const strip = document.createElement("spark-metrics") as MetricsStrip;
    strip.windowSeconds = 300;
    strip.sampledAt = end + 8_000;
    strip.generationSpan = { firstAt: first, endAt: end };
    strip.now = { generationTps: 0, prefillTps: 10, ttftSeconds: null };
    strip.rows = samples.map((sample) => ({ at: sample.at, generation: sample.value, prefill: 10, ttft: null }));
    document.body.append(strip);
    await strip.updateComplete;
    await strip.updateComplete;

    const cards = strip.querySelectorAll(".metric-card");
    const generation = cards[0];
    const prompt = cards[1];
    const meanText = formatMetric(mean, "tokens/s");
    expect(generation?.querySelector(".metric-label")?.textContent).toContain("Generation throughput");
    expect(generation?.querySelector(".metric-number strong")?.textContent).toBe(formatMetric(100, "tokens/s"));
    expect(generation?.querySelector(".metric-mean strong")?.textContent).toBe(meanText);
    expect(generation?.querySelector(".metric-mean strong")?.textContent).not.toBe(formatMetric(statusLine, "tokens/s"));
    expect(generation?.querySelector(".histogram-mean-line title")?.textContent).toContain(
      mean!.toLocaleString(undefined, { maximumSignificantDigits: 3 }),
    );
    expect(generation?.querySelector(".metric-chart")?.getAttribute("aria-label")).toContain(`${values.length} samples`);
    expect(generation?.querySelector(".metric-chart")?.getAttribute("aria-label")).not.toContain(`${samples.length} samples`);
    expect(generation?.querySelectorAll(".histogram-bar.mean-bin")).toHaveLength(1);
    expect(generation?.querySelector("path")?.getAttribute("d")).toBeTruthy();
    expect(prompt?.textContent).toContain("Prompt throughput");
    expect(prompt?.querySelector(".metric-mean strong")?.textContent).toBe(formatMetric(10, "tokens/s"));
    expect(prompt?.querySelector(".metric-number strong")?.textContent).toBe(formatMetric(10, "tokens/s"));

    strip.now = { generationTps: 91.5, prefillTps: 10, ttftSeconds: null };
    await strip.updateComplete;
    expect(strip.querySelectorAll(".metric-card")[0]?.querySelector(".metric-number strong")?.textContent).toBe(formatMetric(91.5, "tokens/s"));
    expect(strip.querySelectorAll(".metric-card")[0]?.querySelector(".metric-mean strong")?.textContent).toBe(meanText);

    strip.rows = [...strip.rows, { at: end + 30_000, generation: 0, prefill: 10, ttft: null }, { at: end + 40_000, generation: statusLine, prefill: 10, ttft: null }];
    strip.sampledAt = end + 40_000;
    await strip.updateComplete;
    expect(strip.querySelectorAll(".metric-card")[0]?.querySelector(".metric-mean strong")?.textContent).toBe(meanText);
    expect(strip.querySelector(".histogram-mean-line title")?.textContent).toContain(
      mean!.toLocaleString(undefined, { maximumSignificantDigits: 3 }),
    );

    strip.generationSpan = null;
    await strip.updateComplete;
    const cleared = strip.querySelectorAll(".metric-card")[0];
    expect(cleared?.querySelector(".metric-mean strong")?.textContent).toBe("—");
    expect(cleared?.querySelector(".histogram-mean-line")).toBeNull();
    expect(cleared?.querySelector("path")?.getAttribute("d")).toBeTruthy();
    strip.remove();
  });
});

describe("probe ring", () => {
  it("keeps a missing TTFT null instead of storing zero", () => {
    const source = { generationTps: 4, prefillTps: 0, ttftSeconds: null };
    const rows = recordProbeRing("spark:1", source, 5_000, source);
    expect(rows).toEqual([{ at: 5_000, generation: 4, prefill: 0, ttft: null }]);
    expect(recordProbeRing("spark:1", source, 9_000, source)).toBe(rows);

    const nextSource = { generationTps: 4, prefillTps: 0, ttftSeconds: 0.4 };
    const next = recordProbeRing("spark:1", nextSource, 8_000, nextSource);
    expect(next[0].ttft).toBeNull();
    expect(next[1].ttft).toBe(0.4);
  });
});
