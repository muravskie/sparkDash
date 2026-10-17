import { describe, expect, it } from "vitest";
import { blankSampling, exportTranscript, importTranscript, type ChatMessage } from "./transcript";

function message(partial: Omit<ChatMessage, "id"> & { id?: string }): ChatMessage {
  return { id: partial.id ?? "m1", ...partial };
}

describe("playground transcript", () => {
  it("round-trips messages, reasoning, tool calls, sampling, and tools", () => {
    const messages = [
      message({ role: "system", content: "Be brief." }),
      message({ role: "user", content: "Look up the weather" }),
      message({
        role: "assistant",
        content: "",
        reasoning: "Need a tool.",
        toolCalls: [{ index: 0, id: "call_1", name: "weather", arguments: "{\"q\":\"SF\"}" }],
      }),
      message({ role: "tool", content: "18C", toolCallId: "call_1", name: "weather" }),
    ];
    const sampling = { ...blankSampling(), temperature: "0.2", thinking: "on" as const, topP: "" };
    const raw = exportTranscript(messages, sampling, "[{\"type\":\"function\"}]");
    const back = importTranscript(raw);

    expect(back.messages.map(({ id: _id, ...rest }) => rest)).toEqual(messages.map(({ id: _id, ...rest }) => rest));
    expect(back.sampling.temperature).toBe("0.2");
    expect(back.sampling.thinking).toBe("on");
    expect(back.sampling.topP).toBe("");
    expect(back.toolsText).toBe("[{\"type\":\"function\"}]");
    expect(raw.includes('"id": "m1"')).toBe(false);
  });

  it("keeps a blank sampling field blank", () => {
    const raw = exportTranscript([], blankSampling(), "");
    const back = importTranscript(raw);
    expect(back.sampling).toEqual(blankSampling());
    expect(back.messages).toEqual([]);
  });

  it("accepts a tools array when toolsText is absent", () => {
    const back = importTranscript(JSON.stringify({
      version: 1,
      messages: [{ role: "user", content: "hi", tool_call_id: "" }],
      tools: [{ type: "function", function: { name: "ping" } }],
    }));
    expect(back.messages).toHaveLength(1);
    expect(back.messages[0].role).toBe("user");
    expect(JSON.parse(back.toolsText)).toEqual([{ type: "function", function: { name: "ping" } }]);
  });

  it("rejects a file that is not a version 1 object", () => {
    expect(() => importTranscript("[]")).toThrow(/JSON object/);
    expect(() => importTranscript("{")).toThrow(/not JSON/);
    expect(() => importTranscript(JSON.stringify({ version: 2, messages: [] }))).toThrow(/version/);
    expect(() => importTranscript(JSON.stringify({ version: 1, messages: [{ role: "nope", content: "x" }] }))).toThrow(/no readable/);
  });
});
