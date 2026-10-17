import http from "node:http";
import express from "express";
import { AGENT_PROXY_COOKIE, authenticate, configuredToken, extractBearer } from "../auth.js";
import { agentDenied } from "./access.js";
import { loadOpencodeCredentials, redactCredentials } from "./credentials.js";
import { basicAuth, frameAncestors, hostName, originAllowed, probeHealth, proxyHttp, upstreamPath } from "./relay.js";
import { EMPTY_AGENT_STATUS, findUbaSpark } from "./uba.js";
import { createUpstreamLocator } from "./upstream.js";
import { createAgentUpgrade } from "./upgrade.js";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** llm-dashboard's OpenCode port on this host. 8093 is free. */
export const DEFAULT_AGENT_PORT = 8093;

/**
 * @param {import("express").Response} res
 * @param {number} status
 * @param {unknown} body
 * @param {{ username?: string, password?: string } | null} [creds]
 */
function sendJson(res, status, body, creds) {
  res.set("Cache-Control", "no-store");
  res.status(status).json(redactCredentials(body, creds));
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function configuredAgentPort(env = process.env) {
  const n = Number.parseInt(String(env.AGENT_PORT || DEFAULT_AGENT_PORT), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_AGENT_PORT;
  return n;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function dashboardPort(env = process.env) {
  const n = Number.parseInt(String(env.PORT || process.env.PORT || "5555"), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 5555;
  return n;
}

/**
 * @param {string} url
 */
function queryHasToken(url) {
  const query = String(url || "").split("?")[1] || "";
  const params = new URLSearchParams(query.split("#")[0]);
  for (const key of params.keys()) {
    if (key.toLowerCase() === "token") return true;
  }
  return false;
}

/**
 * Cookie for this embed port only. The dashboard keeps its token in
 * localStorage, and a cookie set on port 5555 is not how this port authenticates.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
function setAgentCookie(req, res) {
  const token = extractBearer(req);
  if (!token || !configuredToken() || !authenticate(req, { agentCookie: true }).ok) return;
  const secure = Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
  const parts = [
    `${AGENT_PROXY_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=43200",
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/**
 * @param {{ registry?: { sparks?: object[], getSpark?: (id: string) => object | null }, monitors?: Map<string, { snapshot?: () => object }> }} deps
 */
function resolveUba(deps) {
  const sparks = Array.isArray(deps.registry?.sparks) ? deps.registry.sparks : [];
  const snapshots = [];
  if (deps.monitors && typeof deps.monitors.values === "function") {
    for (const monitor of deps.monitors.values()) {
      const snapshot = monitor?.snapshot?.();
      if (snapshot) snapshots.push(snapshot);
    }
  }
  const found = findUbaSpark(sparks, snapshots);
  if (!found?.id) return null;
  return deps.registry?.getSpark?.(found.id) || found;
}

/**
 * llm-dashboard reaches OpenCode on this host's loopback (the existing tunnel).
 * That path is configured by OPENCODE_CREDENTIALS_FILE and does not need a
 * fleet unit named uba.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function credentialsConfigured(env) {
  return Boolean(String(env.OPENCODE_CREDENTIALS_FILE || "").trim());
}

/**
 * @param {object | null} spark
 * @param {boolean} configured
 */
function dialTarget(spark, configured) {
  if (spark) return spark;
  if (!configured) return null;
  return { isLocal: true };
}

/**
 * @param {object} spark
 * @param {{ credentials: { username: string, password: string } | null, error: string | null }} loaded
 * @param {{ healthy: boolean, version: string | null, error: string | null }} [health]
 * @param {number} port
 */
function statusBody(spark, loaded, health, port) {
  return {
    present: true,
    sparkId: spark?.id || null,
    sparkName: typeof spark?.name === "string" ? spark.name : null,
    healthy: Boolean(health?.healthy),
    version: health?.version || null,
    error: health?.error || loaded.error,
    proxyPort: port,
  };
}

/**
 * @param {import("express").Express} app
 * @param {{ registry: { sparks?: object[], getSpark?: (id: string) => object | null }, monitors?: Map<string, { snapshot?: () => object }>, openTunnel?: Function, env?: NodeJS.ProcessEnv }} deps
 */
export function registerAgentRoutes(app, deps) {
  const locator = createUpstreamLocator({ openTunnel: deps.openTunnel, env: deps.env });
  const envOf = () => deps.env || process.env;
  let boundPort = configuredAgentPort(envOf());

  async function readStatus() {
    const env = envOf();
    const spark = resolveUba(deps);
    const configured = credentialsConfigured(env);
    const dial = dialTarget(spark, configured);
    if (!dial) return { status: 200, body: EMPTY_AGENT_STATUS, creds: null };
    const loaded = loadOpencodeCredentials(env);
    if (!loaded.credentials) {
      return { status: 200, body: statusBody(spark, loaded, null, boundPort), creds: null };
    }
    const upstream = locator.parse();
    if (!upstream.ok) {
      return { status: 200, body: statusBody(spark, { credentials: loaded.credentials, error: upstream.error }, null, boundPort), creds: loaded.credentials };
    }
    let target;
    try {
      target = await locator.acquire(dial, upstream);
    } catch {
      return {
        status: 200,
        body: statusBody(spark, { credentials: loaded.credentials, error: "OpenCode on uba is not reachable through SSH" }, null, boundPort),
        creds: loaded.credentials,
      };
    }
    try {
      const health = await probeHealth(target, basicAuth(loaded.credentials));
      return { status: 200, body: statusBody(spark, { credentials: loaded.credentials, error: null }, health, boundPort), creds: loaded.credentials };
    } finally {
      target.release();
    }
  }

  async function resolveProxy(req) {
    const env = envOf();
    const spark = resolveUba(deps);
    const configured = credentialsConfigured(env);
    const dial = dialTarget(spark, configured);
    if (!dial) return { error: "No fleet unit named uba", status: 404, creds: null };
    const loaded = loadOpencodeCredentials(env);
    if (!loaded.credentials) return { error: loaded.error || "OpenCode credentials are not configured", status: 503, creds: null };
    const upstream = locator.parse();
    if (!upstream.ok) return { error: upstream.error, status: 502, creds: loaded.credentials };
    try {
      const target = await locator.acquire(dial, upstream);
      return {
        target,
        auth: basicAuth(loaded.credentials),
        path: upstreamPath(req.originalUrl || req.url || "/"),
        creds: loaded.credentials,
      };
    } catch {
      return { error: "OpenCode on uba is not reachable through SSH", status: 502, creds: loaded.credentials };
    }
  }

  app.get("/api/agent", async (req, res) => {
    const denied = agentDenied(req);
    if (denied) return sendJson(res, denied.status, { error: denied.error }, null);
    try {
      const result = await readStatus();
      sendJson(res, result.status, result.body, result.creds);
    } catch {
      sendJson(res, 503, { error: "OpenCode status could not be read" }, null);
    }
  });

  const embed = express();
  embed.disable("x-powered-by");
  embed.use((req, res) => {
    void handleEmbed(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { error: "OpenCode on uba is not reachable" }, null);
    });
  });
  const embedServer = http.createServer(embed);
  embedServer.on("error", (err) => {
    console.error(`[sparkDash] OpenCode embed error: ${err instanceof Error ? err.message : err}`);
  });
  const upgrade = createAgentUpgrade({ resolve: resolveProxy });
  embedServer.on("upgrade", (req, socket, head) => {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site" || !originAllowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    upgrade(req, socket, head);
  });

  /**
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   * @param {{ status: number, error: string }} denied
   */
  function sendDenied(req, res, denied) {
    const method = (req.method || "GET").toUpperCase();
    const wantsPage = method === "GET" && /text\/html/i.test(String(req.headers.accept || ""));
    if (wantsPage && denied.status === 401) {
      const name = hostName(req.headers.host) || "127.0.0.1";
      const dash = `http://${name}:${dashboardPort(envOf())}/`;
      res.set("Cache-Control", "no-store");
      res.status(401).type("html").send(
        `<!doctype html><meta charset="utf-8"><title>sparkDash</title><p>Dashboard authentication is required.</p><p><a href="${dash}">Open sparkDash</a></p>`
      );
      return;
    }
    sendJson(res, denied.status, { error: denied.error }, null);
  }

  /**
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   */
  async function handleEmbed(req, res) {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
      return sendJson(res, 403, { error: "cross-site request not allowed" }, null);
    }
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      return sendJson(res, 403, { error: "origin not allowed" }, null);
    }
    const denied = agentDenied(req, { agentCookie: true });
    if (denied) return sendDenied(req, res, denied);
    const method = (req.method || "GET").toUpperCase();
    if (!METHODS.has(method)) return sendJson(res, 405, { error: "method not allowed" }, null);
    const path = upstreamPath(req.originalUrl || req.url || "/");
    // The iframe's first URL carries the dashboard token. Drop it before OpenCode
    // reads the document, and keep the session in a cookie on this port.
    if ((method === "GET" || method === "HEAD") && queryHasToken(req.originalUrl || req.url || "")) {
      setAgentCookie(req, res);
      res.set("Cache-Control", "no-store");
      res.set("Referrer-Policy", "no-referrer");
      res.redirect(302, path);
      return;
    }
    const resolved = await resolveProxy(req);
    if ("error" in resolved && !("target" in resolved)) {
      return sendJson(res, resolved.status, { error: resolved.error }, resolved.creds);
    }
    setAgentCookie(req, res);
    try {
      await proxyHttp(req, res, resolved.target, resolved.auth, resolved.path, (response, status, body) => {
        sendJson(response, status, body, resolved.creds);
      }, { frameAncestors: frameAncestors(req.headers.host, dashboardPort(envOf())) });
    } finally {
      resolved.target.release();
    }
  }

  /**
   * @param {string} host
   * @param {number} port
   */
  function listen(host, port) {
    const usePort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : configuredAgentPort(envOf());
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        embedServer.removeListener("error", onError);
        reject(err);
      };
      embedServer.once("error", onError);
      embedServer.listen(usePort, host, () => {
        embedServer.removeListener("error", onError);
        const addr = embedServer.address();
        boundPort = addr && typeof addr === "object" ? addr.port : usePort;
        console.log(`[sparkDash] OpenCode embed listening on http://${host}:${boundPort}/`);
        resolve(boundPort);
      });
    });
  }

  return {
    listen,
    close() {
      locator.closeAll();
      try {
        embedServer.close();
      } catch {
        /* already closed */
      }
    },
  };
}
