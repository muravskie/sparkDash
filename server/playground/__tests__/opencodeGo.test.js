import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import {
  buildOpencodeGoCatalog,
  clearOpencodeGoCache,
  goChatBody,
  handleOpencodeGoStream,
  loadOpencodeGoCatalog,
  loadOpencodeGoKey,
  presentOpencodeGoModel,
} from "../opencodeGo.js";

test("catalog lines keep live ids and attach features and prices", () => {
  const rows = buildOpencodeGoCatalog(
    { data: [{ id: "glm-5.3-flash" }, { id: "omen-alpha" }, { id: "not valid" }] },
    {
      "glm-5.3-flash": {
        name: "GLM-5.3-Flash",
        tool_call: true,
        reasoning: true,
        structured_output: true,
        modalities: { input: ["text", "image"] },
        limit: { context: 1_000_000 },
        cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
      },
      "cat-jam-free": { name: "Cat Jam Free", cost: { input: 0, output: 0 } },
    },
  );
  assert.deepEqual(rows.map((row) => row.id), ["glm-5.3-flash", "omen-alpha"]);
  assert.equal(
    rows[0].line,
    "GLM-5.3-Flash · tools, reasoning, structured, vision, 1M ctx · $0.15 in / $0.50 out / $0.03 cache per 1M",
  );
  assert.deepEqual(rows[0].features, ["tools", "reasoning", "structured", "vision"]);
  assert.equal(rows[0].context, "1M");
  assert.equal(rows[1].line, "omen-alpha");
  assert.deepEqual(rows[1].features, []);
  assert.equal(rows[1].context, null);
  assert.equal(rows[1].cost, null);
  assert.equal(presentOpencodeGoModel("longcat", { name: "LongCat", cost: { input: 0, output: 0 } }).line, "LongCat · free");
});

test("key loader prefers the env key and rejects a loose file", () => {
  assert.equal(loadOpencodeGoKey({ OPENCODE_GO_API_KEY: "console-key" }).key, "console-key");
  const loose = loadOpencodeGoKey({ OPENCODE_GO_KEY_FILE: "/tmp/go-key" }, {
    statSync: () => ({ isFile: () => true, mode: 0o644 }),
    readFileSync: () => "secret",
    existsSync: () => false,
  });
  assert.equal(loose.key, null);
  assert.match(loose.error, /mode 600/);
  const tight = loadOpencodeGoKey({ OPENCODE_GO_KEY_FILE: "/tmp/go-key" }, {
    statSync: () => ({ isFile: () => true, mode: 0o600 }),
    readFileSync: () => "  console-file-key \n",
    existsSync: () => false,
  });
  assert.equal(tight.key, "console-file-key");
});

test("console login database supplies the access token", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-go-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, active INTEGER, time_updated INTEGER, value TEXT)");
  const insert = db.prepare("INSERT INTO credential (integration_id, active, time_updated, value) VALUES (?, 1, ?, ?)");
  insert.run("opencode", 2, JSON.stringify({ type: "oauth", access: "console-access", expires: Date.now() + 60_000 }));
  db.close();
  try {
    assert.equal(loadOpencodeGoKey({ OPENCODE_DB: file }).key, "console-access");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired console login is reported instead of a missing key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-go-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, active INTEGER, time_updated INTEGER, value TEXT)");
  db.prepare("INSERT INTO credential (integration_id, active, time_updated, value) VALUES ('opencode', 1, 1, ?)").run(
    JSON.stringify({ type: "oauth", access: "stale-access", expires: Date.now() - 120_000 }),
  );
  db.close();
  try {
    const loaded = loadOpencodeGoKey({ OPENCODE_DB: file });
    assert.equal(loaded.key, null);
    assert.match(loaded.error, /expired/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy Pi auth is used only when opencode-go-console is present", () => {
  const io = {
    statSync: () => { throw new Error("no"); },
    readFileSync: () => JSON.stringify({ anthropic: { access: "nope" }, "opencode-go-console": { access: "go-token" } }),
    existsSync: () => true,
  };
  assert.equal(loadOpencodeGoKey({ OPENCODE_GO_AUTH_FILE: "/tmp/auth.json" }, io).key, "go-token");
  const missing = loadOpencodeGoKey({ OPENCODE_GO_AUTH_FILE: "/tmp/auth.json" }, {
    ...io,
    readFileSync: () => JSON.stringify({ anthropic: { access: "nope" } }),
  });
  assert.equal(missing.key, null);
});

test("go chat body lifts reasoning effort and drops template kwargs", () => {
  const body = goChatBody({
    provider: "opencode-go",
    modelId: "glm-5.3-flash",
    sessionId: "conv-1",
    messages: [{ role: "user", content: "hi" }],
    thinking_budget: 100,
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" },
  });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.provider, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("stream sends the session header and does not forward the key into the body", async () => {
  clearOpencodeGoCache();
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
    handleOpencodeGoStream({
      res,
      body: req.body,
      signal: AbortSignal.timeout(5000),
      env: {
        OPENCODE_GO_API_KEY: "console-key",
        OPENCODE_GO_BASE_URL: `http://127.0.0.1:${port}`,
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
        provider: "opencode-go",
        modelId: "glm-5.3-flash",
        sessionId: "conv-1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok/);
    assert.equal(seen[0].headers["x-opencode-session"], "conv-1");
    assert.equal(seen[0].headers["user-agent"], "sparkdash/1.0");
    assert.equal(seen[0].headers.authorization, "Bearer console-key");
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(raw.includes("console-key"), false);
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
    handleOpencodeGoStream({
      res,
      body: req.body,
      signal: AbortSignal.timeout(2000),
      env: { OPENCODE_GO_AUTH_FILE: "/missing-auth.json" },
      io: { existsSync: () => false, readFileSync: () => { throw new Error("no"); }, statSync: () => { throw new Error("no"); } },
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
        provider: "opencode-go",
        modelId: "glm-5.3-flash",
        sessionId: "conv-1",
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

test("catalog fetch joins the live list and reports whether a key is configured", async () => {
  clearOpencodeGoCache();
  const catalog = await loadOpencodeGoCatalog({
    env: {},
    io: { existsSync: () => false, readFileSync: () => "", statSync: () => { throw new Error("no"); } },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/models")) {
        return { ok: true, json: async () => ({ data: [{ id: "hy3" }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          "opencode-go": {
            models: {
              hy3: { name: "Hy3", tool_call: true, reasoning: true, cost: { input: 0.14, output: 0.58 } },
            },
          },
        }),
      };
    },
  });
  assert.equal(catalog.credential, false);
  assert.equal(catalog.models[0].line, "Hy3 · tools, reasoning · $0.14 in / $0.58 out per 1M");
});
