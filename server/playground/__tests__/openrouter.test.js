import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  buildOpenRouterCatalog,
  clearOpenRouterCache,
  handleOpenRouterStream,
  loadOpenRouterCatalog,
  loadOpenRouterKey,
  openRouterChatBody,
} from "../openrouter.js";

test("catalog converts per-token prices and keeps chat models", () => {
  const rows = buildOpenRouterCatalog({
    data: [
      {
        id: "anthropic/claude-haiku-5.5",
        name: "Anthropic: Claude Haiku 5.5",
        context_length: 1_000_000,
        architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
        pricing: {
          prompt: "0.0000001",
          completion: "0.0000005",
          input_cache_read: "0.00000001",
          input_cache_write: "0.000000125",
        },
        supported_parameters: ["tools", "reasoning", "structured_outputs"],
      },
      {
        id: "acme/free",
        name: "Free",
        context_length: 8000,
        architecture: { output_modalities: ["text"] },
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: [],
      },
      { id: "not valid", name: "Bad" },
      {
        id: "black-forest-labs/flux",
        name: "Flux",
        architecture: { output_modalities: ["image"] },
        pricing: { prompt: "0", completion: "0" },
      },
      {
        id: "~openai/gpt-latest",
        name: "Latest",
        context_length: 128000,
        architecture: { output_modalities: ["text"] },
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ["anthropic/claude-haiku-5.5", "acme/free", "~openai/gpt-latest"]);
  assert.equal(
    rows[0].line,
    "Anthropic: Claude Haiku 5.5 · tools, reasoning, structured, vision, 1M ctx · $0.10 in / $0.50 out / $0.01 cache / $0.125 cache write per 1M",
  );
  assert.deepEqual(rows[0].features, ["tools", "reasoning", "structured", "vision"]);
  assert.equal(rows[0].context, "1M");
  assert.deepEqual(rows[0].cost, { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
  assert.equal(rows[1].line, "Free · 8K ctx · free");
  assert.equal(rows[2].name, "Latest");
});

test("key loader reads OPENROUTER_API_KEY and rejects a blank value", () => {
  assert.equal(loadOpenRouterKey({ OPENROUTER_API_KEY: " sk-or-test " }).key, "sk-or-test");
  const missing = loadOpenRouterKey({});
  assert.equal(missing.key, null);
  assert.match(missing.error, /not configured/);
  assert.equal(loadOpenRouterKey({ OPENROUTER_API_KEY: "bad\nkey" }).key, null);
});

test("chat body drops engine-only fields and keeps reasoning effort", () => {
  const body = openRouterChatBody({
    provider: "openrouter",
    modelId: "anthropic/claude-haiku-5.5",
    sessionId: "conv-1",
    messages: [{ role: "user", content: "hi" }],
    thinking_budget: 1000,
    chat_template_kwargs: { reasoning_effort: "low" },
  });
  assert.equal(body.provider, undefined);
  assert.equal(body.modelId, undefined);
  assert.equal(body.sessionId, undefined);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.messages[0].content, "hi");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("stream sends the key as a bearer token and does not put it in the body", async () => {
  clearOpenRouterCache();
  /** @type {import("node:http").IncomingMessage[]} */
  const seen = [];
  let raw = "";
  const upstream = http.createServer((req, res) => {
    seen.push(req);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n");
    });
  });
  const port = await listen(upstream);
  const app = express();
  app.use(express.json());
  app.post("/stream", (req, res) => {
    handleOpenRouterStream({
      res,
      body: req.body,
      signal: AbortSignal.timeout(5000),
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_BASE_URL: `http://127.0.0.1:${port}`,
      },
    }).catch((err) => {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    });
  });
  const server = http.createServer(app);
  const local = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${local}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelId: "anthropic/claude-haiku-5.5",
        messages: [{ role: "user", content: "hi" }],
        thinking_budget: 32,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok/);
    assert.equal(seen[0].headers.authorization, "Bearer sk-or-test");
    assert.equal(seen[0].headers["x-title"], "sparkDash");
    assert.equal(seen[0].headers["user-agent"], "sparkdash/1.0");
    assert.equal(seen[0].url, "/v1/chat/completions");
    const forwarded = JSON.parse(raw);
    assert.equal(forwarded.model, "anthropic/claude-haiku-5.5");
    assert.equal(forwarded.thinking_budget, undefined);
    assert.equal(raw.includes("sk-or-test"), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  assert.ok(seen.length);
});

test("a missing key refuses the stream before any upstream call", async () => {
  const app = express();
  app.use(express.json());
  app.post("/stream", (req, res) => {
    handleOpenRouterStream({
      res,
      body: req.body,
      signal: AbortSignal.timeout(2000),
      env: {},
    }).catch((err) => {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    });
  });
  const server = http.createServer(app);
  const local = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${local}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelId: "anthropic/claude-haiku-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /not configured/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("catalog fetch reports whether a key is configured", async () => {
  clearOpenRouterCache();
  const catalog = await loadOpenRouterCatalog({
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
          context_length: 128000,
          architecture: { output_modalities: ["text"] },
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
          supported_parameters: ["tools"],
        }],
      }),
    }),
  });
  assert.equal(catalog.provider, "openrouter");
  assert.equal(catalog.credential, true);
  assert.equal(catalog.models[0].line, "GPT-4o mini · tools, 128K ctx · $0.15 in / $0.60 out per 1M");
  const missing = await loadOpenRouterCatalog({
    env: {},
    now: Date.now() + CACHE_BUST,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  assert.equal(missing.credential, false);
});

const CACHE_BUST = 10 * 60 * 1000;
