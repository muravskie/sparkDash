import { afterEach, describe, expect, it, vi } from "vitest";
import "./view";
import type { Playground } from "./view";
import type { ReplayRun } from "./replays";
import { formatMetric, resetProbeRings, type MetricsStrip } from "./metricsStrip";

const defaults = {
  model_id: "fixture-model",
  engine: "vllm",
  engine_defaults: { temperature: 0.6, top_p: 0.8 },
  engine_source: "Live engine default_sampling_params",
  model_defaults: {},
  model_source: "Not available",
  template_defaults: { enable_thinking: true, reasoning_effort: "low" },
  template_overrides: {},
  template_source: "Not reported",
};

interface OpenPlayground {
  replayRuns: ReplayRun[];
  selectedRunIds: string[];
  generationFirstAt: number | null;
  generationEndAt: number | null;
  generationDefaults: unknown;
  replayBusy: boolean;
  sampledAt: number;
}

const releases: Array<() => void> = [];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

function replayRun(id: string): ReplayRun {
  return {
    id,
    modelId: "fixture-model",
    conversationId: "conv-1",
    at: 1_700_000_000_000,
    user: `Prompt ${id}`,
    system: "",
    temperature: "",
    top_p: "",
    max_tokens: 128,
    thinkingEnabled: null,
    effortLabel: "Default",
    request: { messages: [{ role: "user", content: `Prompt ${id}` }], max_tokens: 128 },
    status: "ready",
  };
}

function contentStream(release: Promise<void>, onStart: () => void) {
  const encoder = new TextEncoder();
  const chunk = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      onStart();
      controller.enqueue(chunk({ choices: [{ delta: { content: "Hi" } }] }));
      await release;
      controller.enqueue(chunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function generationMean(page: HTMLElement) {
  return page.querySelector(".playground-performance .metric-card .metric-mean strong")?.textContent;
}

function generationNow(page: HTMLElement) {
  return page.querySelector(".playground-performance .metric-card .metric-number strong")?.textContent;
}

async function painted(page: Playground) {
  await page.updateComplete;
  const strip = page.querySelector("spark-metrics") as MetricsStrip | null;
  await strip?.updateComplete;
  await page.updateComplete;
}

describe("replay generation span", () => {
  let shift = 0;

  afterEach(() => {
    for (const resolve of releases) resolve();
    releases.length = 0;
    document.querySelector("spark-playground")?.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetProbeRings();
  });

  async function mount(pageProbe: { generationTps: number; prefillTps: number; ttftSeconds: null }) {
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + shift);
    const page = document.createElement("spark-playground") as Playground;
    page.sparkId = "replay-span";
    page.llmPort = 9;
    page.model = { id: "fixture-model", name: "Fixture", healthy: true, engine: "vllm" };
    page.probe = pageProbe;
    document.body.append(page);
    const open = page as unknown as OpenPlayground;
    await vi.waitFor(() => expect(open.generationDefaults).toBeTruthy());
    open.generationFirstAt = open.sampledAt;
    open.generationEndAt = open.sampledAt;
    await painted(page);
    return { page, open };
  }

  it("retargets the generation histogram and mean to the replay batch", async () => {
    let started = 0;
    const gates = [deferred(), deferred()];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("generation-defaults")) {
        return new Response(JSON.stringify(defaults), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const index = started;
      return new Response(contentStream(gates[index].promise, () => {
        started += 1;
        if (started === 1) shift += 5_000;
      }), { status: 200 });
    }));
    const { page, open } = await mount({ generationTps: 10, prefillTps: 4, ttftSeconds: null });
    open.replayRuns = [replayRun("a"), replayRun("b")];
    open.selectedRunIds = ["a", "b"];
    await painted(page);
    expect(generationMean(page)).toBe(formatMetric(10, "tokens/s"));

    const previous = open.generationFirstAt;
    const button = [...page.querySelectorAll("button")].find((item) => item.textContent === "Replay selected") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();

    await vi.waitFor(() => {
      expect(open.generationFirstAt).not.toBe(previous);
      expect(open.generationEndAt).toBeNull();
    });
    page.probe = { generationTps: 40, prefillTps: 4, ttftSeconds: null };
    await painted(page);
    const generation = () => page.querySelector(".playground-performance .metric-card") as HTMLElement;
    expect(generationMean(page)).toBe(formatMetric(40, "tokens/s"));
    expect(generation().querySelector(".histogram-mean-line title")?.textContent).toContain("40");

    gates[0].resolve();
    await vi.waitFor(() => expect(started).toBe(2));
    page.probe = { generationTps: 80, prefillTps: 4, ttftSeconds: null };
    await painted(page);
    expect(generationMean(page)).toBe(formatMetric(60, "tokens/s"));
    expect(generation().querySelector(".metric-chart")?.getAttribute("aria-label")).toContain("2 samples");
    expect(generation().querySelectorAll(".histogram-bar.mean-bin")).toHaveLength(1);

    gates[1].resolve();
    await vi.waitFor(() => expect(open.replayBusy).toBe(false));
    expect(open.generationEndAt).not.toBeNull();
    expect(generationMean(page)).toBe(formatMetric(60, "tokens/s"));

    shift += 5_000;
    page.probe = { generationTps: 200, prefillTps: 9, ttftSeconds: null };
    await painted(page);
    expect(generationNow(page)).toBe(formatMetric(200, "tokens/s"));
    expect(generationMean(page)).toBe(formatMetric(60, "tokens/s"));
    expect(generation().querySelector(".histogram-mean-line title")?.textContent).toContain("60");
    expect(generation().querySelector(".metric-chart")?.getAttribute("aria-label")).toContain("2 samples");
  });

  it("keeps the previous generation span when the replay produces no tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("generation-defaults")) {
        return new Response(JSON.stringify(defaults), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("engine down", { status: 503 });
    }));
    const { page, open } = await mount({ generationTps: 10, prefillTps: 4, ttftSeconds: null });
    const previousFirst = open.generationFirstAt;
    const previousEnd = open.generationEndAt;
    open.replayRuns = [replayRun("a")];
    open.selectedRunIds = ["a"];
    await painted(page);
    const button = [...page.querySelectorAll("button")].find((item) => item.textContent === "Replay selected") as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(open.replayBusy).toBe(false));
    expect(open.generationFirstAt).toBe(previousFirst);
    expect(open.generationEndAt).toBe(previousEnd);
    expect(generationMean(page)).toBe(formatMetric(10, "tokens/s"));
    expect(page.textContent).toContain("Failed");
  });
});
