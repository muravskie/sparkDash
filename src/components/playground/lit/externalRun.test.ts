import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import "./view";
import type { Playground } from "./view";
import { readChatStream, ChatStreamReducer } from "./stream";
import { SseParser } from "./sse";
import { renderTurnStatus } from "./stats";
import { resetProbeRings } from "./metricsStrip";

afterEach(() => {
  document.querySelector("spark-playground")?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProbeRings();
});

function sse(events: unknown[], closeLast = true): string {
  const framed = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (closeLast || !framed.length) return framed.join("");
  const last = framed[framed.length - 1].replace(/\n$/, "");
  return framed.slice(0, -1).join("") + last;
}

describe("provider stream status", () => {
  it("keeps a final usage event that arrives without a trailing blank line", async () => {
    const payload = sse([
      { choices: [{ delta: { content: "Hi" } }] },
      {
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: "20", completion_tokens: 16.2, total_tokens: 36, completion_tokens_details: { reasoning_tokens: 14 } },
      },
    ], false);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const reducer = new ChatStreamReducer();
    for await (const chunk of readChatStream(stream)) reducer.feed(chunk);
    expect(reducer.state.finish).toBe("length");
    expect(reducer.state.usage).toMatchObject({
      prompt_tokens: 20,
      completion_tokens: 16,
      total_tokens: 36,
      completion_tokens_details: { reasoning_tokens: 14 },
    });
  });

  it("names a token limit and an ordinary stop on the status line", () => {
    const host = document.createElement("div");
    render(renderTurnStatus({
      role: "assistant",
      content: "",
      reasoning: "thinking",
      finish: "max_tokens",
      output_limit: 16,
      usage: { prompt_tokens: 20, completion_tokens: 16, total_tokens: 36 },
      stats: { elapsed_ms: 16900, ttft_ms: 628, thinking_tokens: 14, answer_tokens: 2, prefill_tps: 30, generation_tps: 1, ttft_source: "browser", prefill_source: "estimate", generation_source: "estimate" },
    }), host);
    expect(host.textContent).toContain("Token limit reached during thinking");
    expect(host.textContent).toContain("16 completion");
    expect(host.querySelector(".usage-warning")?.getAttribute("title")).toContain("output limit");

    render(renderTurnStatus({
      role: "assistant",
      content: "done",
      finish: "stop",
      usage_estimated: true,
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      stats: { elapsed_ms: 1000, ttft_ms: 100, thinking_tokens: null, answer_tokens: null, prefill_tps: 40, generation_tps: 10, ttft_source: "browser", prefill_source: "estimate", generation_source: "estimate" },
    }), host);
    expect(host.textContent).toContain("End of turn");
    expect(host.textContent).toContain("≈ 4 prompt");
    expect(host.textContent).not.toContain("Token limit");
  });

  it("still parses a blank-line framed event", () => {
    const parser = new SseParser();
    expect(parser.feed("data: {\"ok\":true}\n\n")).toEqual([{ data: "{\"ok\":true}" }]);
    expect(parser.finish()).toEqual([]);
  });
});

describe("external playground charts", () => {
  it("plots the reply and shows the token limit", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 250;
      return clock;
    });
    const events = [
      { choices: [{ delta: { reasoning_content: "Count" } }] },
      { choices: [{ delta: { content: "1" } }] },
      {
        choices: [{ delta: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 20, completion_tokens: 16, total_tokens: 36, completion_tokens_details: { reasoning_tokens: 14 } },
      },
    ];
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse(events.slice(0, 2))));
        controller.enqueue(encoder.encode(`${sse(events.slice(2))}data: [DONE]\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } })));
    const page = document.createElement("spark-playground") as Playground;
    page.sparkId = "local";
    page.external = true;
    page.model = { id: "opencode-go:glm-5.3-flash", name: "GLM", healthy: true, engine: "opencode-go", upstreamId: "glm-5.3-flash", price: { input: 0.15, output: 0.5 } };
    document.body.append(page);
    await page.updateComplete;
    (page as unknown as { draft: string }).draft = "Count to 30";
    await page.updateComplete;
    const button = [...page.querySelectorAll("button")].find((item) => item.textContent === "Send message") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Token limit reached"));
    expect(page.textContent).toContain("20 prompt");
    expect(page.textContent).toContain("16 completion");
    expect(page.textContent).toContain("14 thinking");
    expect(page.textContent).toMatch(/\$0\.00|\$/);
    const generation = page.querySelector(".playground-performance .metric-card .metric-number strong");
    expect(generation?.textContent).not.toBe("—");
    const prompt = page.querySelectorAll(".playground-performance .metric-card")[1]?.querySelector(".metric-number strong");
    expect(prompt?.textContent).not.toBe("—");
  });
});
