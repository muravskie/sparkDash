import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthMiddleware } from "../../auth.js";
import { loadOpencodeCredentials } from "../credentials.js";
import { registerAgentRoutes } from "../routes.js";
import { EMPTY_AGENT_STATUS, findUbaSpark } from "../uba.js";

const USERNAME = "agent-user-9f3a";
const PASSWORD = "s3cret-opencode-pw";
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function registry(sparks) {
  return {
    get sparks() {
      return sparks.map((spark) => ({ ...spark, ssh: { ...(spark.ssh || {}) } }));
    },
    getSpark(id) {
      return sparks.find((spark) => spark.id === id) || null;
    },
  };
}

function writeCreds(contents, mode = 0o600) {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-creds-"));
  const file = path.join(dir, typeof contents === "string" ? "opencode.env" : "opencode.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  chmodSync(file, mode);
  return { dir, file };
}

async function withProcessEnv(vars, fn) {
  const prev = new Map();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withProxy(deps, fn, { auth = false } = {}) {
  const app = express();
  app.use(express.json());
  if (auth) app.use(createAuthMiddleware());
  const agent = registerAgentRoutes(app, deps);
  const server = http.createServer(app);
  const api = await listen(server);
  const embed = await agent.listen("127.0.0.1", 0);
  try {
    return await fn({ api, embed });
  } finally {
    agent.close();
    await close(server);
  }
}

test("agent proxy", async (t) => {
  await t.test("uba matching uses the fleet name or hostname and ignores other addresses", () => {
    assert.equal(findUbaSpark([{ id: "a", name: "Ubuntu", lanIp: "192.168.1.20", ssh: { host: "192.168.1.20" } }]), null);
    assert.equal(findUbaSpark([{ id: "a", name: "UBA", ssh: { host: "10.1.1.1" } }]).id, "a");
    assert.equal(findUbaSpark([{ id: "b", name: "spark", ssh: { host: "uba.local" } }]).id, "b");
    const snapshots = [{ id: "c", metrics: { tailscale: { hostName: "uba", dnsName: "uba.tail.ts.net" } } }];
    assert.equal(findUbaSpark([{ id: "c", name: "spark", ssh: { host: "10.0.0.8" } }], snapshots).id, "c");
  });

  await t.test("credentials stay out of JSON, including a loose credentials file", async () => {
    const loose = writeCreds({ username: USERNAME, password: PASSWORD }, 0o644);
    const tight = writeCreds({ username: USERNAME, password: PASSWORD });
    const lines = writeCreds(`# secret\nOPENCODE_USERNAME=${USERNAME}\nOPENCODE_PASSWORD=${PASSWORD}\n`);
    try {
      const refused = loadOpencodeCredentials({ OPENCODE_CREDENTIALS_FILE: loose.file });
      assert.equal(refused.credentials, null);
      assert.match(refused.error, /mode 600/);
      assert.equal(JSON.stringify(refused).includes(PASSWORD), false);
      assert.deepEqual(loadOpencodeCredentials({ OPENCODE_CREDENTIALS_FILE: lines.file }).credentials, {
        username: USERNAME,
        password: PASSWORD,
      });

      const hits = [];
      const upstream = http.createServer((req, res) => {
        hits.push({ authorization: req.headers.authorization || "", url: req.url || "" });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version: PASSWORD, pid: 7, note: USERNAME, password: PASSWORD }));
      });
      const upstreamPort = await listen(upstream);
      try {
        await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
          const spark = { id: "uba", name: "uba", isLocal: true, lanIp: "10.9.9.9", ssh: { host: "10.9.9.9", user: "me" } };
          await withProxy(
            {
              registry: registry([spark]),
              env: { OPENCODE_CREDENTIALS_FILE: tight.file, OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
              openTunnel: async () => {
                throw new Error("ssh should not run for a local unit");
              },
            },
            async ({ api }) => {
              const res = await fetch(`http://127.0.0.1:${api}/api/agent`);
              const body = await res.json();
              const raw = JSON.stringify(body);
              assert.equal(res.status, 200);
              assert.equal(body.present, true);
              assert.equal(body.healthy, true);
              assert.equal(body.sparkId, "uba");
              assert.equal(raw.includes(PASSWORD), false);
              assert.equal(raw.includes(USERNAME), false);
              assert.equal(raw.includes("10.9.9.9"), false);
              assert.equal(hits[0].authorization, BASIC);
            }
          );
        });
      } finally {
        await close(upstream);
      }
    } finally {
      rmSync(loose.dir, { recursive: true, force: true });
      rmSync(tight.dir, { recursive: true, force: true });
      rmSync(lines.dir, { recursive: true, force: true });
    }
  });

  await t.test("a credentials file reaches loopback OpenCode without a fleet unit named uba", async () => {
    const creds = writeCreds({ password: PASSWORD });
    const hits = [];
    const upstream = http.createServer((req, res) => {
      hits.push(req.headers.authorization || "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "2.0.0", pid: 4 }));
    });
    const upstreamPort = await listen(upstream);
    let tunnels = 0;
    try {
      await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
        const spark = { id: "other", name: "spark-e596", isLocal: true, lanIp: "127.0.0.1", ssh: { host: "127.0.0.1", user: "me" } };
        await withProxy(
          {
            registry: registry([spark]),
            env: { OPENCODE_CREDENTIALS_FILE: creds.file, OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
            openTunnel: async () => {
              tunnels += 1;
              throw new Error("loopback upstream must not open an SSH tunnel");
            },
          },
          async ({ api, embed }) => {
            const res = await fetch(`http://127.0.0.1:${api}/api/agent`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.present, true);
            assert.equal(body.healthy, true);
            assert.equal(body.sparkId, null);
            assert.equal(body.version, "2.0.0");
            assert.equal(body.proxyPort, embed);
            assert.equal(JSON.stringify(body).includes(PASSWORD), false);
            assert.equal(hits[0], `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`);
            assert.equal(tunnels, 0);
          }
        );
      });
    } finally {
      await close(upstream);
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  await t.test("a missing uba spark returns the empty state and does not guess a host", async () => {
    let tunnels = 0;
    const spark = { id: "other", name: "Ubuntu", isLocal: false, lanIp: "192.168.9.9", ssh: { host: "192.168.9.9", user: "me" } };
    await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
      await withProxy(
        {
          registry: registry([spark]),
          env: { OPENCODE_UPSTREAM: "http://127.0.0.1:9" },
          openTunnel: async () => {
            tunnels += 1;
            throw new Error("should not tunnel");
          },
        },
        async ({ api }) => {
          const res = await fetch(`http://127.0.0.1:${api}/api/agent`);
          const body = await res.json();
          assert.equal(res.status, 200);
          assert.deepEqual(body, EMPTY_AGENT_STATUS);
          assert.equal(JSON.stringify(body).includes("192.168"), false);
          assert.equal(JSON.stringify(body).includes(PASSWORD), false);
          assert.equal(tunnels, 0);
        }
      );
    });
  });

  await t.test("an unauthenticated remote client is rejected", async () => {
    const creds = writeCreds({ username: USERNAME, password: PASSWORD });
    const hits = [];
    const upstream = http.createServer((req, res) => {
      hits.push(req.headers.authorization || "");
      res.end("nope");
    });
    const upstreamPort = await listen(upstream);
    try {
      await withProcessEnv(
        {
          BIND_HOST: "10.4.4.4",
          SPARKDASH_TOKEN: "dash-token-zz",
          DASHBOARD_TOKEN: null,
          SPARKDASH_ALLOW_OPEN_REMOTE: "0",
        },
        async () => {
          const spark = { id: "uba", name: "UBA", isLocal: true, lanIp: "10.8.8.8", ssh: { host: "10.8.8.8", user: "me" } };
          await withProxy(
            {
              registry: registry([spark]),
              env: { OPENCODE_CREDENTIALS_FILE: creds.file, OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
            },
            async ({ api, embed }) => {
              const res = await fetch(`http://127.0.0.1:${embed}/`, {
                headers: { accept: "text/html" },
              });
              assert.equal(res.status, 401);
              assert.equal((await res.text()).includes(PASSWORD), false);
              assert.equal(hits.length, 0);

              const posted = await fetch(`http://127.0.0.1:${embed}/session`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              });
              const body = await posted.json();
              assert.equal(posted.status, 401);
              assert.equal(JSON.stringify(body).includes(PASSWORD), false);
              assert.equal(JSON.stringify(body).includes(USERNAME), false);

              const status = await fetch(`http://127.0.0.1:${api}/api/agent`);
              assert.equal(status.status, 401);
              assert.equal((await status.text()).includes(PASSWORD), false);

              const ws = new WebSocket(`ws://127.0.0.1:${embed}/pty`);
              const closed = once(ws, "error").then(() => true);
              assert.equal(await closed, true);
              ws.close();

              const opened = await fetch(`http://127.0.0.1:${embed}/?token=dash-token-zz`, {
                headers: { accept: "text/html" },
                redirect: "manual",
              });
              assert.equal(opened.status, 302);
              const landed = new URL(opened.headers.get("location") || "", `http://127.0.0.1:${embed}`);
              assert.equal(landed.pathname, "/");
              assert.equal(landed.search, "");
              const setCookie = opened.headers.get("set-cookie") || "";
              assert.match(setCookie, /^sparkdash_agent=/);
              const page = await fetch(`http://127.0.0.1:${embed}/`, {
                headers: { accept: "text/html", cookie: setCookie.split(";")[0] },
              });
              assert.equal(page.status, 200);
              assert.equal(new URL(page.url).pathname, "/");
              const apiWithCookie = await fetch(`http://127.0.0.1:${api}/api/agent`, {
                headers: { cookie: setCookie.split(";")[0] },
              });
              assert.equal(apiWithCookie.status, 401);
            },
            { auth: true }
          );
        }
      );
    } finally {
      await close(upstream);
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  await t.test("a test double upstream receives basic auth and not a browser-chosen host", async () => {
    const creds = writeCreds({ username: USERNAME, password: PASSWORD });
    const hits = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization || "",
          host: req.headers.host || "",
          body: Buffer.concat(chunks).toString("utf8"),
          accept: req.headers.accept || "",
        });
        if (req.url === "/global/health") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ healthy: true, version: "v1" }));
          return;
        }
        if ((req.headers.accept || "").includes("text/html")) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end('<!doctype html><head></head><a href="/assets/app.js">');
          return;
        }
        if ((req.headers.accept || "").includes("text/event-stream")) {
          res.setHeader("content-type", "text/event-stream");
          res.write("data: one\n\n");
          res.end("data: two\n\n");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const upstreamPort = await listen(upstream);
    try {
      await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
        const spark = { id: "uba", name: "uba", isLocal: true, lanIp: "10.2.2.2", ssh: { host: "10.2.2.2", user: "me" } };
        await withProxy(
          {
            registry: registry([spark]),
            env: { OPENCODE_CREDENTIALS_FILE: creds.file, OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/ignored` },
            openTunnel: async () => {
              throw new Error("local unit must not open an SSH tunnel");
            },
          },
          async ({ api, embed }) => {
            const redirected = await fetch(`http://127.0.0.1:${embed}/?upstream=http://10.9.9.9:9999&token=dash-secret`, {
              headers: { accept: "text/html", authorization: "Bearer dash-secret" },
              redirect: "manual",
            });
            assert.equal(redirected.status, 302);
            const next = new URL(redirected.headers.get("location") || "", `http://127.0.0.1:${embed}`);
            assert.equal(next.pathname, "/");
            assert.equal(next.search.includes("token"), false);
            assert.equal(next.search.includes("10.9.9.9"), false);
            const page = await fetch(next, { headers: { accept: "text/html" } });
            const html = await page.text();
            assert.equal(page.status, 200);
            assert.equal(new URL(page.url).pathname, "/");
            assert.equal(html.includes("/agent/proxy"), false);
            assert.match(html, /href="\/assets\/app\.js"/);
            assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors/);
            assert.equal(page.headers.get("x-frame-options"), null);
            assert.equal(html.includes(PASSWORD), false);
            assert.equal(html.includes("10.9.9.9"), false);
            const document = hits.find((hit) => hit.accept.includes("text/html"));
            assert.equal(document.authorization, BASIC);
            assert.equal(document.authorization.includes("dash-secret"), false);
            assert.equal(document.host.startsWith("127.0.0.1:"), true);
            assert.equal(document.url.includes("token"), false);
            assert.equal(document.url.includes("10.9.9.9"), false);
            assert.equal(document.url.split("?")[0], "/");

            const stream = await fetch(`http://127.0.0.1:${embed}/event`, {
              headers: { accept: "text/event-stream" },
            });
            assert.equal(stream.status, 200);
            assert.match(stream.headers.get("content-type") || "", /text\/event-stream/);
            assert.match(await stream.text(), /data: one/);
            assert.equal(hits.some((hit) => hit.accept.includes("text/event-stream") && hit.authorization === BASIC), true);

            hits.length = 0;
            upstream.removeAllListeners("request");
            upstream.on("request", (req, res) => {
              if (req.url !== "/api/info" && req.url !== "/global/health") {
                res.statusCode = 404;
                res.end("missing");
                return;
              }
              hits.push(req.url);
              if (req.url === "/api/info") {
                res.statusCode = 404;
                res.end("no v2");
                return;
              }
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ healthy: true, version: "v1" }));
            });
            const status = await fetch(`http://127.0.0.1:${api}/api/agent`);
            const body = await status.json();
            assert.equal(body.healthy, true);
            assert.equal(body.version, "v1");
            assert.deepEqual(hits, ["/api/info", "/global/health"]);
            assert.equal(JSON.stringify(body).includes(PASSWORD), false);
          }
        );
      });
    } finally {
      await close(upstream);
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  await t.test("a remote unit is reached through the SSH tunnel, which receives basic auth", async () => {
    const creds = writeCreds({ username: USERNAME, password: PASSWORD });
    const hits = [];
    const upstream = http.createServer((req, res) => {
      hits.push({ authorization: req.headers.authorization || "", host: req.headers.host || "", url: req.url || "" });
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if ((req.url || "").startsWith("/api/info")) {
          res.end(JSON.stringify({ version: "2.0.0", pid: 4 }));
          return;
        }
        res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    const upstreamPort = await listen(upstream);
    const opened = [];
    try {
      await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
        const spark = { id: "remote-uba", name: "Uba", isLocal: false, lanIp: "10.7.7.7", ssh: { host: "10.7.7.7", user: "me", auth: "key" } };
        await withProxy(
          {
            registry: registry([spark]),
            env: { OPENCODE_CREDENTIALS_FILE: creds.file },
            openTunnel: async (target, port) => {
              opened.push({ id: target.id, host: target.ssh?.host, port });
              return { host: "127.0.0.1", port: upstreamPort, via: "ssh-tunnel", close() {} };
            },
          },
          async ({ embed }) => {
            const res = await fetch(`http://127.0.0.1:${embed}/session?upstream=http://10.7.7.7:14096`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer dash-secret" },
              body: "{\"n\":1}",
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.ok, true);
            assert.equal(body.body, "{\"n\":1}");
            assert.equal(JSON.stringify(body).includes(PASSWORD), false);
            assert.equal(opened.length >= 1, true);
            assert.equal(opened[0].port, 14096);
            assert.equal(opened[0].id, "remote-uba");
            assert.equal(hits.some((hit) => hit.authorization === BASIC && hit.url.startsWith("/session")), true);
            assert.equal(hits.some((hit) => String(hit.host).includes("10.7.7.7")), false);
            assert.equal(hits.some((hit) => hit.authorization.includes("dash-secret")), false);
          }
        );
      });
    } finally {
      await close(upstream);
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  await t.test("the websocket upgrade sends basic auth to the upstream", async () => {
    const creds = writeCreds({ username: USERNAME, password: PASSWORD });
    const upstream = http.createServer((req, res) => {
      res.end("ok");
    });
    const wss = new WebSocketServer({ server: upstream });
    const wsAuth = [];
    wss.on("connection", (socket, req) => {
      wsAuth.push({ authorization: req.headers.authorization || "", url: req.url || "" });
      socket.close();
    });
    const upstreamPort = await listen(upstream);
    try {
      await withProcessEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: null, DASHBOARD_TOKEN: null }, async () => {
        const spark = { id: "uba", name: "uba", isLocal: true, ssh: { host: "127.0.0.1", user: "me" } };
        await withProxy(
          {
            registry: registry([spark]),
            env: { OPENCODE_CREDENTIALS_FILE: creds.file, OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
          },
          async ({ embed }) => {
            const ws = new WebSocket(`ws://127.0.0.1:${embed}/pty`);
            await once(ws, "open");
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("upstream websocket did not see basic auth")), 2000);
              const timerCheck = setInterval(() => {
                if (wsAuth.length) {
                  clearInterval(timerCheck);
                  clearTimeout(timer);
                  resolve();
                }
              }, 20);
            });
            assert.equal(wsAuth[0].authorization, BASIC);
            assert.equal(wsAuth[0].url, "/pty");
            ws.close();
          }
        );
      });
    } finally {
      wss.close();
      await close(upstream);
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });
});
