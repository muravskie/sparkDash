import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { controllerHost, createControllerClient, socketCommand } from "../client.js";
import { SourceError } from "../errors.js";
import { scriptGuard } from "../guard.js";
import { Operations } from "../operations.js";
import { blockScriptLaunch, registerModelRoutes } from "../routes.js";

const SECRET = "controller-bearer-key-9f3a2c7e1b";
const spark = { id: "s1", isLocal: true, lanIp: "127.0.0.1", ssh: { host: "127.0.0.1", user: "me", auth: "key" } };

function registered(over = {}) {
  return {
    id: "qwen3.8-27b",
    enabled: true,
    ownership: "managed",
    runtime: "running",
    roles: ["text-generation"],
    inference_endpoint: "http://127.0.0.1:30000/v1",
    ...over,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function mount(client, extras = {}) {
  const app = express();
  app.use(express.json());
  const operations = extras.operations || new Operations(client);
  const cache = extras.cache || new Map();
  registerModelRoutes(app, {
    registry: { getSpark: (id) => (id === "s1" ? spark : null) },
    client,
    operations,
    cache,
    readKey: () => SECRET,
    monitors: extras.monitors,
    launchers: extras.launchers,
  });
  return { app, operations, cache };
}

async function withServer(client, extras, fn) {
  const mounted = mount(client, extras);
  const server = http.createServer(mounted.app);
  const port = await listen(server);
  try {
    return await fn(port, mounted);
  } finally {
    await close(server);
  }
}

async function json(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json();
  return { status: res.status, body, raw: JSON.stringify(body) };
}

test("the controller is reached on the Spark LAN host", () => {
  assert.equal(controllerHost({ isLocal: true, lanIp: "192.168.1.64", ssh: { host: "127.0.0.1" } }), "192.168.1.64");
  assert.equal(controllerHost({ isLocal: true, ssh: { host: "spark.local" } }), "spark.local");
  assert.equal(controllerHost({ isLocal: true }), "127.0.0.1");
});

test("an external model is rejected and does not start a switch", async () => {
  let actions = 0;
  const client = {
    status: async () => ({ models: [registered({ id: "external", ownership: "external" })] }),
    transactions: async () => ({ transactions: [] }),
    action: async () => {
      actions += 1;
      return { transaction_id: "t", status: "active" };
    },
  };
  await withServer(client, {}, async (port) => {
    const res = await json(port, "/api/sparks/s1/models/external/activate", { method: "POST" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /externally owned/);
    assert.equal(actions, 0);
    assert.equal(res.raw.includes(SECRET), false);
  });
});

test("an unfinished controller transaction rejects a new switch", async () => {
  let actions = 0;
  const client = {
    status: async () => ({ models: [registered()] }),
    transactions: async () => ({
      transactions: [
        { transaction_id: "done", phase: "committed", model_id: "qwen3.8-27b", operation: "activate" },
        { transaction_id: "open", phase: "started", model_id: "qwen3.8-27b", operation: "activate" },
        { transaction_id: "open", phase: "stopping", model_id: "qwen3.8-27b", operation: "activate" },
      ],
    }),
    action: async () => {
      actions += 1;
      return { transaction_id: "t", status: "active" };
    },
  };
  await withServer(client, {}, async (port) => {
    const res = await json(port, "/api/sparks/s1/models/qwen3.8-27b/activate", { method: "POST" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /unfinished transaction/);
    assert.equal(actions, 0);
  });
});

test("an unknown outcome blocks another switch until it is acknowledged", async () => {
  let calls = 0;
  let finish = () => {};
  const client = {
    status: async () => ({ models: [registered({ runtime: "absent", ownership: null })] }),
    transactions: async () => ({ transactions: [] }),
    action: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          finish = () => reject(new SourceError(`lost ${SECRET}`));
        });
      }
      return { transaction_id: "t2", status: "active" };
    },
  };
  await withServer(client, {}, async (port, { operations }) => {
    const first = await json(port, "/api/sparks/s1/models/qwen3.8-27b/activate", { method: "POST" });
    assert.equal(first.status, 202);
    assert.equal(first.body.state, "working");
    assert.equal(first.raw.includes(SECRET), false);
    finish();
    await operations.drain();
    const blocked = await json(port, "/api/sparks/s1/models/qwen3.8-27b/deactivate", { method: "POST" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /unresolved/);
    const board = await json(port, "/api/sparks/s1/models");
    assert.equal(board.body.operations[0].state, "unknown");
    assert.equal(board.body.active, first.body.id);
    assert.equal(board.raw.includes(SECRET), false);
    const ack = await json(port, `/api/sparks/s1/models/operations/${first.body.id}/acknowledge`, { method: "POST" });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acknowledged, true);
    assert.equal(ack.raw.includes(SECRET), false);
    const again = await json(port, "/api/sparks/s1/models/qwen3.8-27b/activate", { method: "POST" });
    assert.equal(again.status, 202);
    await operations.drain();
  });
});

test("controller errors and model rows do not echo the bearer key", async () => {
  const client = {
    status: async () => {
      throw new SourceError(`down ${SECRET}`);
    },
    transactions: async () => ({ transactions: [] }),
    action: async () => ({ transaction_id: "t", status: "active" }),
  };
  await withServer(client, {}, async (port) => {
    const board = await json(port, "/api/sparks/s1/models");
    assert.equal(board.status, 200);
    assert.equal(board.body.available, false);
    assert.equal(board.body.configured, true);
    assert.equal(board.raw.includes(SECRET), false);
    assert.match(board.body.error, /\[redacted\]/);
  });
});

test("a closed controller port falls back to the unix socket and a refused key does not", async () => {
  const ssh = [];
  const refused = createControllerClient({
    key: () => SECRET,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
      return {
        status: 401,
        text: async () => JSON.stringify({ error: SECRET }),
      };
    },
    sshRequest: async () => {
      throw new Error("ssh should not run");
    },
  });
  await assert.rejects(
    () => refused.status(spark),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(String(err.message).includes(SECRET), false);
      return true;
    }
  );

  const fallback = createControllerClient({
    key: () => SECRET,
    fetchImpl: async () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    },
    sshRequest: async (_spark, method, path) => {
      ssh.push({ method, path });
      return { status: 200, body: { models: [registered()] } };
    },
  });
  const status = await fallback.status(spark);
  assert.equal(status.models[0].id, "qwen3.8-27b");
  assert.deepEqual(ssh, [{ method: "GET", path: "/v1/status" }]);
  assert.equal(socketCommand("POST", "/v1/models/qwen3.8-27b/activate", {}, 30).includes(SECRET), false);
});

test("a timed-out activate is not sent again over the socket", async () => {
  let ssh = 0;
  const client = createControllerClient({
    key: () => SECRET,
    fetchImpl: async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
    sshRequest: async () => {
      ssh += 1;
      return { status: 200, body: { transaction_id: "t", status: "active" } };
    },
  });
  await assert.rejects(() => client.action(spark, "qwen3.8-27b", "activate"), SourceError);
  assert.equal(ssh, 0);
});

test("script guard matches a launcher by port and hides the list when it cannot", () => {
  const managed = [{ id: "qwen3.8-27b", name: "qwen3.8-27b", endpoint: "http://10.0.0.2:30000/v1", ownership: "managed", runtime: "running", registered: true }];
  const matched = scriptGuard(
    [{ id: "launcher-a", name: "other", dir: "/models/other", port: 30000 }],
    managed
  );
  assert.equal(matched.hideAll, false);
  assert.deepEqual(matched.blockedIds, ["launcher-a"]);
  const unmatched = scriptGuard(
    [{ id: "launcher-b", name: "GLM", dir: "/models/glm", port: 8888 }],
    managed
  );
  assert.equal(unmatched.hideAll, true);
  assert.deepEqual(unmatched.blockedIds, ["launcher-b"]);
  const byName = scriptGuard(
    [{ id: "launcher-c", name: "Qwen 3.8 27B", dir: "/models/qwen", port: null }],
    managed
  );
  assert.equal(byName.hideAll, false);
  assert.deepEqual(byName.blockedIds, ["launcher-c"]);
});

test("script launch uses a cached controller reading and does not open SSH by itself", async () => {
  let calls = 0;
  const client = {
    status: async (_spark, options) => {
      calls += 1;
      assert.equal(options.ssh, false);
      return { models: [registered()] };
    },
    transactions: async () => ({ transactions: [] }),
    action: async () => ({ transaction_id: "t", status: "active" }),
  };
  const cache = new Map();
  const reason = await blockScriptLaunch(
    client,
    cache,
    spark,
    { id: "launcher-a", name: "other", port: 30000 },
    [{ id: "launcher-a", name: "other", dir: "/m", port: 30000 }]
  );
  assert.match(reason, /Models page/);
  assert.equal(calls, 1);
  const again = await blockScriptLaunch(
    client,
    cache,
    spark,
    { id: "launcher-b", name: "GLM", port: 8888 },
    [{ id: "launcher-b", name: "GLM", dir: "/m", port: 8888 }]
  );
  assert.match(again, /cannot be matched/);
  assert.equal(calls, 1);
});
