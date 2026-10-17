import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatBody, messagesForReplay, parseConcurrency } from "../requestBody.js";
import { samplingProfile } from "../sampling.js";

const allOn = Object.fromEntries(
  ["temperature", "topP", "topK", "maxTokens", "presencePenalty", "thinking", "reasoningEffort", "thinkingBudget"].map(
    (key) => [key, { enabled: true, default: null }]
  )
);

test("buildChatBody omits blank sampling and disabled controls", () => {
  const body = buildChatBody({
    modelId: "demo",
    messages: [{ role: "user", content: "hi" }],
    sampling: { temperature: "", topP: "0.9", topK: "40", maxTokens: "128" },
    accepted: {
      ...allOn,
      topK: { enabled: false, default: null },
    },
  });
  assert.equal(body.model, "demo");
  assert.equal(body.stream, true);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.top_k, undefined);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.chat_template_kwargs, undefined);
});

test("buildChatBody carries reasoning text, tool calls, and typed tool results", () => {
  const body = buildChatBody({
    modelId: null,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        reasoning: "call the tool",
        toolCalls: [{ id: "call_1", name: "weather", arguments: "{\"q\":\"SF\"}" }],
      },
      { role: "tool", toolCallId: "call_1", content: "18C", name: "weather" },
    ],
    sampling: {},
    accepted: allOn,
    tools: [{ type: "function", function: { name: "weather" } }],
  });
  assert.equal(body.model, undefined);
  assert.equal(body.messages[1].content, null);
  assert.equal(body.messages[1].reasoning_content, "call the tool");
  assert.equal(body.messages[1].tool_calls[0].id, "call_1");
  assert.equal(body.messages[1].tool_calls[0].function.name, "weather");
  assert.deepEqual(body.messages[2], { role: "tool", tool_call_id: "call_1", content: "18C", name: "weather" });
  assert.equal(body.tools.length, 1);
});

test("thinking flags are sent only when the control is set", () => {
  const blank = buildChatBody({
    modelId: "m",
    messages: [{ role: "user", content: "hi" }],
    sampling: { thinking: "", thinkingBudget: "" },
    accepted: allOn,
  });
  assert.equal(blank.chat_template_kwargs, undefined);

  const on = buildChatBody({
    modelId: "m",
    messages: [{ role: "user", content: "hi" }],
    sampling: { thinking: "on", thinkingBudget: "256", reasoningEffort: "low" },
    accepted: allOn,
  });
  assert.equal(on.chat_template_kwargs.enable_thinking, true);
  assert.equal(on.chat_template_kwargs.thinking_budget, 256);
  assert.equal(on.reasoning_budget, 256);
  assert.equal(on.reasoning_effort, "low");

  const off = buildChatBody({
    modelId: "m",
    messages: [{ role: "user", content: "hi" }],
    sampling: { thinking: "off" },
    accepted: { ...allOn, thinking: { enabled: false } },
  });
  assert.equal(off.chat_template_kwargs, undefined);
});

test("replay drops a trailing assistant turn and checks concurrency", () => {
  const messages = messagesForReplay([
    { role: "user", content: "hi" },
    { role: "assistant", content: "old" },
  ]);
  assert.deepEqual(messages, [{ role: "user", content: "hi" }]);
  assert.equal(parseConcurrency(3), 3);
  assert.throws(() => parseConcurrency(0), /concurrency/);
  assert.throws(() => parseConcurrency(9), /concurrency/);
});

test("sampling defaults stay null unless the engine document reports them", () => {
  const unknown = samplingProfile(null, []);
  assert.equal(unknown.temperature.enabled, true);
  assert.equal(unknown.temperature.default, null);
  assert.equal(unknown.topK.enabled, false);
  assert.equal(unknown.thinking.enabled, false);
  assert.equal(unknown.thinkingBudget.default, null);

  const llama = samplingProfile("llama.cpp", [
    {
      default_generation_settings: {
        params: { temperature: 0.8, top_k: 40, top_p: 0.95, n_predict: -1, presence_penalty: 0 },
      },
    },
  ]);
  assert.equal(llama.temperature.default, 0.8);
  assert.equal(llama.topK.default, 40);
  assert.equal(llama.topK.enabled, true);
  assert.equal(llama.topP.default, 0.95);
  assert.equal(llama.presencePenalty.default, 0);
  assert.equal(llama.maxTokens.default, null);
  assert.equal(llama.thinking.default, null);
  assert.equal(llama.reasoningEffort.enabled, false);

  const reported = samplingProfile("vllm", [
    { generation_config: { thinking_budget: 1024, reasoning_effort: "medium" } },
  ]);
  assert.equal(reported.thinkingBudget.default, 1024);
  assert.equal(reported.reasoningEffort.default, "medium");
  assert.equal(reported.temperature.default, null);
});
