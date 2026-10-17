import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { ModelsPage } from "./ModelsPage";

const model = {
  id: "qwen3.8-27b",
  name: "qwen3.8-27b",
  endpoint: "http://10.0.0.8:30000/v1",
  roles: ["text-generation"],
  engine: "sglang",
  ownership: "managed",
  runtime: "absent",
  health: { status: "unknown", label: "Not checked", reason: null },
  registered: true,
  enabled: true,
};

function board(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    available: true,
    error: null,
    models: [model],
    active: null,
    operations: [],
    events: [],
    scriptGuard: { hideAll: false, blockedIds: [], reason: null },
    ...over,
  };
}

describe("ModelsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an empty state when the Spark has no controller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => board({ configured: false, available: false, models: [] }) })));
    const { container } = render(<ModelsPage sparks={[makeSpark("a")]} />);
    await flush();
    expect(container.textContent).toContain("No model controller");
    expect(container.textContent).not.toContain("start.sh");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Activate")).toBe(false);
  });

  it("asks before activating and leaves external rows as monitoring only", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        return {
          ok: true,
          json: async () => board({
            models: [
              model,
              { ...model, id: "external:8000", name: "flash", registered: false, ownership: "external-monitor", endpoint: "http://10.0.0.8:8000/v1", engine: "vllm", runtime: "unknown" },
            ],
          }),
        };
      })
    );
    const { container } = render(<ModelsPage sparks={[makeSpark("a")]} />);
    await flush();
    expect(container.textContent).toContain("Explicit external monitor");
    expect(container.textContent).toContain("monitoring only");
    const activate = [...container.querySelectorAll("button")].find((button) => button.textContent === "Activate");
    expect(activate).toBeTruthy();
    act(() => activate!.click());
    await flush();
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm activate");
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());
    await flush();
    expect(calls.some((call) => call.includes("/activate") && call.startsWith("POST"))).toBe(true);
  });

  it("asks for an acknowledgement when an outcome is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => board({
          active: "op1",
          operations: [{ id: "op1", model_id: "qwen3.8-27b", action: "activate", state: "unknown", error: "Review the controller", result: null, acknowledged: false }],
          events: [{ model_id: "qwen3.8-27b", operation: "activate", phase: "stopping", transaction_id: "txn-1" }],
        }),
      }))
    );
    const { container } = render(<ModelsPage sparks={[makeSpark("a")]} />);
    await flush();
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).toContain("txn-1");
    expect(container.textContent).toContain("Acknowledge after review");
    const activate = [...container.querySelectorAll("button")].find((button) => button.textContent === "Activate") as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
  });
});
