import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  buildGoRequest,
  createGoTranslator,
  goProtocol,
  openAiUsage,
} from "../goProtocols.js";
import { handleOpencodeGoStream } from "../opencodeGo.js";

const chat = {
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Oslo?" },
    {
      role: "assistant",
      content: "Checking.",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Oslo\"}" } }],
    },
    { role: "tool", tool_call_id: "call-1", content: "rain" },
    { role: "user", content: "Thanks" },
  ],
  max_tokens: 32,
  temperature: 0.2,
  top_p: 0.8,
  reasoning_effort: "low",
  tools: [{ type: "function", function: { name: "weather", description: "Forecast", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
};

test("protocol table leaves chat-completions models on the chat path", () => {
  assert.equal(goProtocol("glm-5.3-flash"), "chat");
  assert.equal(goProtocol("qwen3.8-flash"), "chat");
  assert.equal(goProtocol("qwen3.7-plus"), "chat");
  assert.equal(goProtocol("minimax-m3"), "chat");
  assert.equal(goProtocol("hy3"), "chat");
  assert.equal(goProtocol("muse-spark-1.3-contributor"), "responses");
  assert.equal(goProtocol("grok-4.6"), "responses");
  assert.equal(goProtocol("gpt-6-luna"), "responses");
  assert.equal(goProtocol("claude-haiku-5-5"), "anthropic");
  assert.equal(goProtocol("minimax-m2.7"), "anthropic");
  assert.equal(goProtocol("gemini-4-argon-contributor"), "google");
});

test("responses request lifts system text and tool calls out of messages", () => {
  const built = buildGoRequest("muse-spark-1.3-contributor", chat);
  assert.equal(built.path, "/openai/v1/responses");
  assert.equal(built.body.instructions, "Be brief.");
  assert.equal(built.body.max_output_tokens, 32);
  assert.equal(built.body.temperature, 0.2);
  assert.deepEqual(built.body.reasoning, { effort: "low" });
  assert.equal(built.body.tools[0].name, "weather");
  assert.deepEqual(built.body.input.map((item) => item.type || item.role), ["user", "assistant", "function_call", "function_call_output", "user"]);
  assert.equal(built.body.input[2].call_id, "call-1");
  assert.equal(built.body.input[2].arguments, "{\"city\":\"Oslo\"}");
  assert.equal(built.body.input[3].output, "rain");
});

test("anthropic request keeps system separate and merges the tool result into the next user turn", () => {
  const built = buildGoRequest("claude-haiku-5-5", chat);
  assert.equal(built.path, "/anthropic/v1/messages");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  assert.equal(built.body.system, "Be brief.");
  assert.equal(built.body.max_tokens, 32);
  assert.equal(built.body.top_p, undefined);
  assert.equal(built.body.tools[0].input_schema.properties.city.type, "string");
  assert.equal(built.body.messages[1].content[0].type, "text");
  assert.equal(built.body.messages[1].content[1].type, "tool_use");
  assert.equal(built.body.messages[1].content[1].input.city, "Oslo");
  assert.equal(built.body.messages[2].content[0].type, "tool_result");
  assert.equal(built.body.messages[2].content[1].text, "Thanks");
});

test("anthropic requires max_tokens", () => {
  assert.throws(() => buildGoRequest("minimax-m2.7", { messages: [{ role: "user", content: "hi" }] }), /max_tokens/);
});

test("google request puts the model in the path and maps assistant to model", () => {
  const built = buildGoRequest("gemini-4-argon-contributor", { ...chat, top_k: 20 });
  assert.equal(built.path, "/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse");
  assert.equal(built.body.systemInstruction.parts[0].text, "Be brief.");
  assert.equal(built.body.generationConfig.maxOutputTokens, 32);
  assert.equal(built.body.generationConfig.topK, 20);
  assert.deepEqual(built.body.contents.map((turn) => turn.role), ["user", "model", "user"]);
  assert.equal(built.body.contents[1].parts[1].functionCall.name, "weather");
  assert.equal(built.body.contents[2].parts[0].functionResponse.response.result, "rain");
  assert.equal(built.body.contents[2].parts[1].text, "Thanks");
  assert.equal(built.body.tools[0].functionDeclarations[0].name, "weather");
});

test("responses events become chat chunks and ignore encrypted reasoning", () => {
  const translator = createGoTranslator("responses");
  const chunks = [
    ...translator.push({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "secret-blob" } }),
    ...translator.push({ type: "response.reasoning_summary_text.delta", delta: "plan" }),
    ...translator.push({ type: "response.output_text.delta", delta: "ok" }),
    ...translator.push({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
      },
    }),
    ...translator.end(),
  ];
  assert.equal(JSON.stringify(chunks).includes("secret-blob"), false);
  assert.equal(chunks[0].choices[0].delta.reasoning_content, "plan");
  assert.equal(chunks[1].choices[0].delta.content, "ok");
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
  assert.equal(chunks[2].usage.prompt_tokens, 13);
  assert.equal(chunks[2].usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(chunks[2].usage.prompt_tokens_details.cached_tokens, 2);
});

test("responses function-call deltas keep one tool index", () => {
  const translator = createGoTranslator("responses");
  const start = translator.push({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call-9", name: "weather" } });
  const args = translator.push({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"city\":" });
  const done = translator.push({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
  assert.equal(start[0].choices[0].delta.tool_calls[0].id, "call-9");
  assert.equal(start[0].choices[0].delta.tool_calls[0].function.name, "weather");
  assert.equal(args[0].choices[0].delta.tool_calls[0].index, start[0].choices[0].delta.tool_calls[0].index);
  assert.equal(args[0].choices[0].delta.tool_calls[0].id, undefined);
  assert.equal(done[0].choices[0].finish_reason, "tool_calls");
});

test("anthropic stream maps text, thinking, and stop reason", () => {
  const translator = createGoTranslator("anthropic");
  const chunks = [
    ...translator.push({ type: "message_start", message: { usage: { input_tokens: 16, cache_read_input_tokens: 4 } } }),
    ...translator.push({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
    ...translator.push({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
    ...translator.push({ type: "ping" }),
    ...translator.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 2 } } }),
    ...translator.end(),
  ];
  assert.equal(chunks[0].choices[0].delta.reasoning_content, "hmm");
  assert.equal(chunks[1].choices[0].delta.content, "ok");
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
  assert.deepEqual(chunks[2].usage, openAiUsage({ input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 4, output_tokens_details: { thinking_tokens: 2 } }));
});

test("google stream skips signatures and emits the later usage with the finish", () => {
  const translator = createGoTranslator("google");
  const first = translator.push({
    candidates: [{ content: { parts: [{ text: "ok" }, { text: "think", thought: true }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
  });
  const second = translator.push({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "", thoughtSignature: "sig" }] } }],
    usageMetadata: { promptTokenCount: 36, candidatesTokenCount: 5, thoughtsTokenCount: 4, totalTokenCount: 41 },
  });
  assert.equal(first[0].choices[0].delta.content, "ok");
  assert.equal(first[1].choices[0].delta.reasoning_content, "think");
  assert.equal(JSON.stringify(first).includes("sig"), false);
  assert.equal(second[0].choices[0].finish_reason, "stop");
  assert.equal(second[0].usage.prompt_tokens, 36);
  assert.equal(second[0].usage.completion_tokens_details.reasoning_tokens, 4);
  assert.equal(translator.end().length, 0);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("adapted stream posts the family endpoint and returns chat chunks", async () => {
  /** @type {{ url: string, body: string, authorization: string | undefined }[]} */
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url || "", body: Buffer.concat(chunks).toString("utf8"), authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url?.includes("responses")) {
        res.end("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"total_tokens\":4}}}\n\n");
        return;
      }
      if (req.url?.includes("messages")) {
        res.end("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":1}}\n\n");
        return;
      }
      res.end("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"MAX_TOKENS\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":1,\"totalTokenCount\":3}}\n\n");
    });
  });
  const port = await listen(upstream);
  const app = express();
  app.use(express.json());
  app.post("/stream", (req, res) => {
    handleOpencodeGoStream({
      res,
      body: req.body,
      signal: AbortSignal.timeout(5000),
      env: { OPENCODE_GO_API_KEY: "go-key", OPENCODE_GO_BASE_URL: `http://127.0.0.1:${port}` },
    }).catch((err) => {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    });
  });
  const server = http.createServer(app);
  const local = await listen(server);
  try {
    for (const modelId of ["muse-spark-1.2-contributor", "minimax-m2.7", "gemini-4-argon-contributor"]) {
      const response = await fetch(`http://127.0.0.1:${local}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "opencode-go",
          modelId,
          sessionId: "conv-1",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 16,
        }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /"content":"ok"/);
      assert.match(text, /data: \[DONE\]/);
      assert.equal(text.includes("go-key"), false);
    }
    assert.equal(seen[0].url, "/openai/v1/responses");
    assert.equal(seen[1].url, "/anthropic/v1/messages");
    assert.equal(seen[2].url, "/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse");
    assert.equal(seen[0].authorization, "Bearer go-key");
    assert.equal(seen[0].body.includes("go-key"), false);
    assert.match(await Promise.resolve(seen[1].body), /"max_tokens":16/);
    assert.match(seen[0].body, /"max_output_tokens":16/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
