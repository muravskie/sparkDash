import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { clearToken, setToken } from "../../api/authToken";
import { agentFrameSrc } from "./api";
import { AgentPage } from "./AgentPage";

const empty = {
  present: false,
  sparkId: null,
  sparkName: null,
  healthy: false,
  version: null,
  error: null,
  proxyPort: null,
};

describe("AgentPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says OpenCode is not configured and does not embed a host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => empty })));
    const { container } = render(<AgentPage />);
    await flush();
    expect(container.textContent).toContain("OpenCode is not configured");
    expect(container.textContent).toContain("does not guess a host");
    expect(container.textContent).toContain("fleet unit named uba is not required");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows an unavailable state when OpenCode is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...empty,
          present: true,
          sparkId: "uba",
          sparkName: "uba",
          error: "OpenCode on uba is not reachable",
          proxyPort: 8093,
        }),
      }))
    );
    const { container } = render(<AgentPage />);
    await flush();
    expect(container.textContent).toContain("OpenCode is unavailable");
    expect(container.textContent).toContain("not reachable");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("frames the same-origin proxy when OpenCode is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...empty,
          present: true,
          sparkId: "uba",
          sparkName: "uba",
          healthy: true,
          version: "1.2.3",
          proxyPort: 8093,
        }),
      }))
    );
    const { container } = render(<AgentPage />);
    await flush();
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("http://localhost:8093/");
    expect(frame?.getAttribute("src")).not.toContain("/agent/proxy");
  });

  it("builds the embed URL from the page hostname", () => {
    expect(agentFrameSrc(8093, { protocol: "http:", hostname: "spark-e596.local" })).toBe("http://spark-e596.local:8093/");
    expect(agentFrameSrc(8093, { protocol: "https:", hostname: "100.101.204.94" })).toBe("https://100.101.204.94:8093/");
    setToken("dash-token-zz");
    expect(agentFrameSrc(8093, { protocol: "http:", hostname: "spark-e596.local" })).toBe(
      "http://spark-e596.local:8093/?token=dash-token-zz"
    );
    clearToken();
  });
});
