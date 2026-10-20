import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { PlaygroundPage } from "./PlaygroundPage";
import type { Playground } from "./lit/view";

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

describe("PlaygroundPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts the llm-dashboard playground with sampling, import, and presets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => defaults,
      }))
    );
    const { container } = render(<PlaygroundPage sparks={[makeSpark("a")]} />);
    const page = container.querySelector("spark-playground") as Playground | null;
    expect(page).toBeTruthy();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Engine default: 0.6");
    });

    const text = container.textContent || "";
    expect(text).toContain("Spark a");
    expect(container.querySelector("h1")).toBeNull();
    for (const label of ["Temperature", "Top P", "Top K", "Presence penalty", "Thinking budget", "Thinking", "Reasoning effort"]) {
      expect(text).toContain(label);
    }
    expect(container.querySelector("[aria-label='Max tokens']")).toBeTruthy();
    expect(text).toContain("Import JSON");
    expect(text).toContain("Save preset");
    expect(text).toContain("Prompt runs");
    expect(text).toContain("Engine default: 0.6");
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".playground-performance .metric-card")).toHaveLength(2);
      expect(container.querySelector(".playground-performance .overlay-view")).toBeTruthy();
    });
    const strip = container.querySelector(".playground-performance");
    expect(strip?.textContent).toContain("Live engine performance");
    expect(strip?.textContent).toContain("Generation throughput");
    expect(strip?.textContent).toContain("Prompt throughput");
    expect(strip?.textContent).not.toContain("Mean time to first token");
    expect(strip?.querySelector(".overlay-view")).toBeTruthy();
    expect(strip?.querySelector("[aria-label='Playground time window']")).toBeTruthy();
  });

  it("lists OpenCode Go models under Remote instead of a host", async () => {
    localStorage.removeItem("sparkdash.playground-opencode-go-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/providers/opencode-go/models")) {
          return {
            ok: true,
            json: async () => ({
              credential: true,
              models: [{
                id: "glm-5.3-flash",
                name: "GLM-5.3-Flash",
                line: "GLM-5.3-Flash · tools, reasoning · $0.15 in / $0.50 out per 1M",
                features: ["tools", "reasoning"],
                context: "1M",
                cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
              }],
            }),
          };
        }
        return { ok: true, json: async () => defaults };
      })
    );
    const { container } = render(<PlaygroundPage sparks={[makeSpark("a")]} />);
    const remote = [...container.querySelectorAll("button")].find((button) => button.textContent === "Remote");
    expect(remote).toBeTruthy();
    await act(async () => { remote?.click(); });
    await vi.waitFor(() => {
      expect(container.querySelector("[aria-label='Provider']")).toBeTruthy();
      expect(container.querySelector("[aria-label='Model']")?.textContent).toContain("GLM-5.3-Flash");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Model']")?.click();
    });
    const headers = [...container.querySelectorAll(".bp-model-table th")].map((cell) => cell.textContent);
    expect(headers.slice(0, 8)).toEqual(["Model", "Features", "Context", "In", "Out", "Cache", "Write", "Go $10"]);
    const row = container.querySelector(".bp-model-table tbody tr");
    expect(row?.textContent).toContain("tools, reasoning");
    expect(row?.textContent).toContain("1M");
    expect(row?.textContent).toContain("$0.15");
    expect(row?.textContent).toContain("$0.50");
    expect(row?.textContent).toContain("$0.03");
    expect(container.querySelector("[aria-label='Remote host']")).toBeNull();
    expect((container.querySelector("[aria-label='Provider']") as HTMLSelectElement).value).toBe("opencode-go");
    expect(container.querySelector("[aria-label='Filter models']")).toBeTruthy();
    expect(container.querySelector("[aria-label='Reload models']")).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Reload models']")?.click();
    });
    await vi.waitFor(() => {
      const urls = fetchMock.mock.calls.slice(before).map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/providers/opencode-go/models?refresh=1"))).toBe(true);
    });
  });

  it("lists DeepSeek V4.1 Flash Free under the OpenCode provider", async () => {
    localStorage.removeItem("sparkdash.playground-opencode-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("/providers/opencode/models")) {
          return {
            ok: true,
            json: async () => ({
              credential: true,
              models: [{
                id: "deepseek-v4.1-flash-free",
                name: "DeepSeek V4.1 Flash Free",
                line: "DeepSeek V4.1 Flash Free · free",
                features: ["reasoning"],
                context: "200K",
                cost: { input: 0, output: 0 },
              }],
            }),
          };
        }
        if (path.includes("/providers/opencode-go/models")) {
          return {
            ok: true,
            json: async () => ({
              credential: true,
              models: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", line: "GLM", features: [], context: null, cost: null }],
            }),
          };
        }
        return { ok: true, json: async () => defaults };
      })
    );
    const { container } = render(<PlaygroundPage sparks={[makeSpark("a")]} />);
    const remote = [...container.querySelectorAll("button")].find((button) => button.textContent === "Remote");
    await act(async () => { remote?.click(); });
    await vi.waitFor(() => {
      expect(container.querySelector("[aria-label='Provider']")).toBeTruthy();
    });
    const select = container.querySelector("[aria-label='Provider']") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "opencode");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[aria-label='Model']")?.textContent).toContain("DeepSeek V4.1 Flash Free");
    });
    expect(container.textContent).toContain("sent through the OpenCode CLI");
  });

  it("lists OpenRouter models when that provider is selected", async () => {
    localStorage.removeItem("sparkdash.playground-openrouter-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("/providers/openrouter/models")) {
          return {
            ok: true,
            json: async () => ({
              credential: true,
              models: [
                {
                  id: "anthropic/claude-haiku-5.5",
                  name: "Anthropic: Claude Haiku 5.5",
                  line: "Anthropic: Claude Haiku 5.5",
                  features: ["tools", "reasoning"],
                  context: "1M",
                  cost: { input: 0.1, output: 0.5 },
                },
                {
                  id: "openai/gpt-4o-mini",
                  name: "GPT-4o mini",
                  line: "GPT-4o mini",
                  features: ["tools"],
                  context: "128K",
                  cost: { input: 0.15, output: 0.6 },
                },
              ],
            }),
          };
        }
        if (path.includes("/providers/opencode-go/models")) {
          return {
            ok: true,
            json: async () => ({
              credential: true,
              models: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", line: "GLM", features: [], context: null, cost: null }],
            }),
          };
        }
        return { ok: true, json: async () => defaults };
      })
    );
    const { container } = render(<PlaygroundPage sparks={[makeSpark("a")]} />);
    const remote = [...container.querySelectorAll("button")].find((button) => button.textContent === "Remote");
    await act(async () => { remote?.click(); });
    await vi.waitFor(() => {
      expect(container.querySelector("[aria-label='Provider']")).toBeTruthy();
    });
    const select = container.querySelector("[aria-label='Provider']") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "openrouter");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[aria-label='Model']")?.textContent).toContain("Anthropic: Claude Haiku 5.5");
    });
    expect(container.textContent).toContain("come from OpenRouter");
    expect(container.textContent).not.toContain("OPENROUTER_API_KEY");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Model']")?.click();
    });
    const filter = container.querySelector("[aria-label='Filter models']") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(filter, "gpt-4o");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".bp-model-table tbody")?.textContent).toContain("GPT-4o mini");
    expect(container.querySelector(".bp-model-table tbody")?.textContent).not.toContain("Claude Haiku");
  });
});
