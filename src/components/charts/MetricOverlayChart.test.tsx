import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmMetrics } from "../../api/types";
import { render } from "../../testing/render";
import { histogram16 } from "./chartGeometry";
import { LlmMetricOverlay, MetricOverlayChart } from "./MetricOverlayChart";
import { readLlmChartRings, resetLlmChartRings } from "./llmChartBuffer";

afterEach(() => {
  resetLlmChartRings();
});

function probe(partial: Partial<LlmMetrics>): LlmMetrics {
  return partial as LlmMetrics;
}

describe("MetricOverlayChart", () => {
  it("highlights the bin that contains the mean and breaks the line across a gap", () => {
    const end = 31_000;
    const values = [0, 0, 0, 0, 0, 15, 15, 15, 15, 15];
    const steady = values.map((value, index) => ({ at: end - 30_000 + index * 1_000, value }));
    const bins = histogram16(values);
    const steadyView = render(<MetricOverlayChart label="Decode" unit="tok/s" mode="overlay" samples={steady} end={end} />);
    expect(steadyView.container.querySelector("[data-mean-bin]")?.getAttribute("data-mean-bin")).toBe(String(bins.meanBin));
    expect(steadyView.container.querySelectorAll(".metric-overlay__bar.is-mean")).toHaveLength(1);
    expect(steadyView.container.querySelector(".metric-overlay__mean")).not.toBeNull();

    const gapped = [0, 2_000, 4_000, 6_000, 8_000, 10_000, 25_000, 27_000, 29_000, 31_000].map((at) => ({ at, value: 4 }));
    const gapView = render(<MetricOverlayChart label="Prefill" unit="tok/s" mode="overlay" samples={gapped} end={end} />);
    const path = gapView.container.querySelector(".metric-overlay__line")?.getAttribute("d") ?? "";
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("moves the crosshair with the keyboard and clears it on Escape", () => {
    const end = 8_000;
    const samples = [0, 2_000, 4_000, 6_000, 8_000].map((at, index) => ({ at, value: index + 1 }));
    const { container } = render(<MetricOverlayChart label="Decode" unit="tok/s" samples={samples} end={end} />);
    const plot = container.querySelector(".metric-overlay__plot");
    expect(plot).not.toBeNull();
    act(() => {
      plot!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain("1 tok/s");
    act(() => {
      plot!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain("2 tok/s");
    act(() => {
      plot!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("draws a ratio as percent", () => {
    const { container } = render(
      <MetricOverlayChart label="Hit" unit="ratio" samples={[{ at: 1_000, value: 0.25 }]} end={1_000} />
    );
    expect(container.querySelector(".metric-overlay__unit")?.textContent).toBe("%");
    expect(container.textContent).toContain("%");
  });
});

describe("LlmMetricOverlay", () => {
  it("charts each port on its own and omits a metric the probe did not publish", () => {
    const { container: first } = render(
      <LlmMetricOverlay
        sparkId="spark-a"
        llmPort={8000}
        active
        llm={probe({ generationTps: 0, prefillTps: 12, ttftSeconds: null })}
      />
    );
    const { container: second } = render(
      <LlmMetricOverlay
        sparkId="spark-a"
        llmPort={8001}
        active
        llm={probe({ generationTps: 9, prefillTps: 3, ttftSeconds: 0.4 })}
      />
    );

    expect(readLlmChartRings("spark-a:8000").generation.at(-1)?.value).toBe(0);
    expect(readLlmChartRings("spark-a:8000").ttft.at(-1)?.value).toBeNull();
    expect(readLlmChartRings("spark-a:8001").generation.at(-1)?.value).toBe(9);
    expect(readLlmChartRings("spark-a:8001").ttft.at(-1)?.value).toBe(0.4);
    expect(first.textContent).toContain("Decode");
    expect(first.textContent).toContain("Prefill");
    expect(first.textContent).not.toContain("TTFT");
    expect(second.textContent).toContain("TTFT");

    const again = probe({ generationTps: undefined, prefillTps: 4, ttftSeconds: null });
    const { container } = render(<LlmMetricOverlay sparkId="spark-b" llmPort={1} active llm={again} />);
    expect(container.textContent).not.toContain("Decode");
    expect(container.textContent).toContain("Prefill");
  });
});
