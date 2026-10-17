import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { registerPlaygroundRoutes } from "../relay.js";

const spark = {
  id: "s1",
  workerNode: false,
  llmMonitoring: true,
  llmPorts: [4321],
  llmPort: 4321,
};

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("playground session reports probe identity and only documented sampling defaults", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    const auth = req.headers.authorization;
    assert.equal(auth, "Bearer test-key");
    if (req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        default_generation_settings: { params: { temperature: 0.7, top_k: 20, n_predict: -1 } },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);

  let closed = 0;
  const app = express();
  app.use(express.json());
  registerPlaygroundRoutes(app, {
    registry: { getSpark: (id) => (id === "s1" ? spark : null) },
    monitors: new Map([
      ["s1", { snapshot: () => ({ metrics: { llm: [{ port: 4321, backend: "llama.cpp", modelId: "from-probe" }] } }) }],
    ]),
    benchHttpTarget: async () => ({
      port: 4321,
      tls: false,
      apiKey: "test-key",
      custom: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
        via: "ssh-tunnel",
        close: () => {
          closed += 1;
        },
      }),
    }),
  });
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sparks/s1/playground/session?port=4321`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.modelId, "from-probe");
    assert.equal(body.backend, "llama.cpp");
    assert.equal(body.via, "ssh-tunnel");
    assert.equal(body.controls.temperature.default, 0.7);
    assert.equal(body.controls.topK.default, 20);
    assert.equal(body.controls.maxTokens.default, null);
    assert.equal(body.controls.topP.default, null);
    assert.equal(body.controls.reasoningEffort.enabled, false);
    assert.ok(seen.includes("/props"));
    assert.equal(closed, 1);

    const missing = await fetch(`http://127.0.0.1:${port}/api/sparks/missing/playground/session?port=4321`);
    assert.equal(missing.status, 404);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("playground chat relays text, reasoning, and tool-call fragments and forwards the API key", async () => {
  let chatBody = null;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.equal(req.headers.authorization, "Bearer test-key");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      chatBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseChunk({ choices: [{ delta: { reasoning_content: "think" } }] }));
      res.write(sseChunk({ choices: [{ delta: { content: "Hi" } }] }));
      res.write(sseChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "" } }] } }],
      }));
      res.write(sseChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      }));
      res.end("data: [DONE]\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerPlaygroundRoutes(app, {
    registry: { getSpark: () => spark },
    monitors: new Map([
      ["s1", { snapshot: () => ({ metrics: { llm: [{ port: 4321, backend: "llama.cpp", modelId: "from-probe" }] } }) }],
    ]),
    benchHttpTarget: async () => ({
      port: 4321,
      tls: false,
      apiKey: "test-key",
      custom: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
        via: "direct",
        close() {},
      }),
    }),
  });
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sparks/s1/playground/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        port: 4321,
        messages: [{ role: "user", content: "hi" }],
        sampling: { temperature: "0.2", topK: "40", thinking: "" },
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"reasoning":"think"/);
    assert.match(text, /"name":"lookup"/);
    assert.match(text, /"arguments":"\{\}"/);
    assert.equal(chatBody.model, "from-probe");
    assert.equal(chatBody.temperature, 0.2);
    assert.equal(chatBody.top_k, 40);
    assert.equal(chatBody.chat_template_kwargs, undefined);
    assert.equal(chatBody.messages[0].content, "hi");
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("playground stop aborts the upstream request", async () => {
  let upstreamClosed = false;
  const upstream = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    req.on("aborted", () => {
      upstreamClosed = true;
    });
    req.on("close", () => {
      if (!res.writableEnded) upstreamClosed = true;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseChunk({ choices: [{ delta: { content: "partial" } }] }));
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerPlaygroundRoutes(app, {
    registry: { getSpark: () => spark },
    monitors: new Map([
      ["s1", { snapshot: () => ({ metrics: { llm: [{ port: 4321, backend: "vllm", modelId: "m" }] } }) }],
    ]),
    benchHttpTarget: async () => ({
      port: 4321,
      tls: false,
      apiKey: null,
      custom: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
        via: "direct",
        close() {},
      }),
    }),
  });
  const server = http.createServer(app);
  const port = await listen(server);
  const ac = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${port}/api/sparks/s1/playground/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 4321, messages: [{ role: "user", content: "hi" }], sampling: {} }),
      signal: ac.signal,
    });
    const res = await pending;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("partial")) {
      const step = await reader.read();
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
    }
    assert.match(buf, /partial/);
    ac.abort();
    await reader.read().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(upstreamClosed, true);
  } finally {
    ac.abort();
    await close(server);
    await close(upstream);
  }
});

test("playground stream pipes engine SSE and generation-defaults reports live sampling", async () => {
  let chatBody = null;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/server_info?config_format=json") {
      assert.equal(req.headers.authorization, "Bearer test-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        default_sampling_params: { temperature: 0.6, top_p: 0.8, api_key: "secret" },
        generation_config: { temperature: 1 },
        default_chat_template_kwargs: { enable_thinking: false, reasoning_effort: "low", secret: "no" },
      }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      chatBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${sseChunk({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }], usage: { completion_tokens: 1 } })}data: [DONE]\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use("/api/sparks/:id/playground/stream", express.json({ limit: "8mb" }));
  app.use(express.json());
  registerPlaygroundRoutes(app, {
    registry: { getSpark: () => spark },
    monitors: new Map([
      ["s1", { snapshot: () => ({ metrics: { llm: [{ port: 4321, backend: "vllm", modelId: "served" }] } }) }],
    ]),
    benchHttpTarget: async () => ({
      port: 4321,
      tls: false,
      apiKey: "test-key",
      custom: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: upstreamPort,
        via: "direct",
        close() {},
      }),
    }),
  });
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const defaults = await fetch(`http://127.0.0.1:${port}/api/sparks/s1/playground/generation-defaults?port=4321`);
    const meta = await defaults.json();
    assert.equal(defaults.status, 200);
    assert.equal(meta.engine, "vllm");
    assert.equal(meta.engine_defaults.temperature, 0.6);
    assert.equal(meta.engine_defaults.top_p, 0.8);
    assert.equal(meta.model_defaults.temperature, 1);
    assert.equal(meta.template_overrides.enable_thinking, false);
    assert.equal(meta.template_overrides.reasoning_effort, "low");
    assert.equal(JSON.stringify(meta).includes("secret"), false);

    const res = await fetch(`http://127.0.0.1:${port}/api/sparks/s1/playground/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        port: 4321,
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        max_tokens: 2048,
        chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" },
        thinking_token_budget: 128,
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /\[DONE\]/);
    assert.equal(chatBody.model, "served");
    assert.equal(chatBody.temperature, 0.2);
    assert.equal(chatBody.max_tokens, 2048);
    assert.equal(chatBody.stream, true);
    assert.equal(chatBody.stream_options.include_usage, true);
    assert.equal(chatBody.thinking_token_budget, 128);
    assert.equal(chatBody.chat_template_kwargs.reasoning_effort, "high");
    assert.equal(chatBody.port, undefined);
  } finally {
    await close(server);
    await close(upstream);
  }
});
