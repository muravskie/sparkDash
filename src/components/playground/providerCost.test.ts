import { describe, expect, it } from "vitest";
import { formatUsd, turnCostUsd } from "./providerCost";

describe("provider reply cost", () => {
  const paid = { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0.2 };

  it("bills fresh input, cached input, and output at per-1M rates", () => {
    const cost = turnCostUsd({
      prompt_tokens: 1_000_000,
      completion_tokens: 2_000_000,
      prompt_tokens_details: { cached_tokens: 250_000 },
    }, paid);
    // 750k * 0.15 + 250k * 0.03 + 2M * 0.5
    expect(cost).toBeCloseTo(0.75 * 0.15 + 0.25 * 0.03 + 2 * 0.5, 8);
  });

  it("omits free models and replies that never reported usage", () => {
    expect(turnCostUsd({ prompt_tokens: 10, completion_tokens: 10 }, { input: 0, output: 0 })).toBeNull();
    expect(turnCostUsd(undefined, paid)).toBeNull();
    expect(turnCostUsd({}, paid)).toBeNull();
  });

  it("formats the status-line amount", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.2)).toBe("$1.20");
    expect(formatUsd(0.00042)).toBe("$0.0004");
    expect(formatUsd(0.0000042)).toBe("$0.000004");
  });
});
