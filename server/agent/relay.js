/**
 * Copyright (c) 2026 hasso5703. Adapted under the MIT license.
 *
 * Node proxy for OpenCode. Header hygiene, Basic authentication, and the
 * health-check reading follow the Cockpit agent relay. This file is a new
 * implementation; the Python relay is not included.
 */

import http from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_DROP = new Set([...HOP_BY_HOP, "host", "cookie", "authorization", "content-length", "referer", "referrer"]);
const RESPONSE_DROP = new Set([
  ...HOP_BY_HOP,
  "content-length",
  "date",
  "server",
  "www-authenticate",
  "authorization",
  "proxy-authorization",
]);
const DROP_QUERY = new Set(["token", "upstream", "host", "url"]);
export const MAX_BODY = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 3000;

/**
 * @param {{ username: string, password: string }} creds
 */
export function basicAuth(creds) {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64")}`;
}

/**
 * Loopback only. A browser cannot choose this URL.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseUpstream(env = process.env) {
  const raw = String(env.OPENCODE_UPSTREAM || "http://127.0.0.1:14096").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "OPENCODE_UPSTREAM is not a URL" };
  }
  if (url.protocol !== "http:") return { ok: false, error: "OPENCODE_UPSTREAM must be an http loopback URL" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return { ok: false, error: "OPENCODE_UPSTREAM must stay on loopback" };
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "OPENCODE_UPSTREAM port is invalid" };
  }
  return { ok: true, host: "127.0.0.1", port };
}

/**
 * @param {string} originalUrl
 */
/**
 * OpenCode path at the embed origin. The browser document is already at `/`.
 * Query keys that would choose an upstream or carry the dashboard token are dropped.
 * @param {string} originalUrl
 */
export function upstreamPath(originalUrl) {
  const raw = String(originalUrl || "/");
  const hashless = raw.split("#")[0];
  const q = hashless.indexOf("?");
  const pathname = q === -1 ? hashless : hashless.slice(0, q);
  const query = q === -1 ? "" : hashless.slice(q + 1);
  let rest = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!rest.startsWith("/") || rest.startsWith("//") || rest.includes("://") || rest.includes("\\")) rest = "/";
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (DROP_QUERY.has(key.toLowerCase())) params.delete(key);
  }
  const qs = params.toString();
  return qs ? `${rest}?${qs}` : rest;
}

/**
 * Host from a Host header, safe to place in a URL or CSP source.
 * @param {string | undefined} hostHeader
 */
export function hostName(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw || /[\s;'"\\]/.test(raw)) return "";
  let name = raw;
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    name = end === -1 ? "" : name.slice(0, end + 1);
  } else if (name.includes(":")) {
    const colon = name.indexOf(":");
    name = name.indexOf(":", colon + 1) === -1 ? name.slice(0, colon) : `[${name}]`;
  }
  if (!name || !/^\[?[A-Za-z0-9._:-]+\]?$/.test(name)) return "";
  return name;
}

/**
 * Only this embed, and the dashboard on the same host, may frame OpenCode.
 * @param {string | undefined} hostHeader
 * @param {number} dashboardPort
 */
export function frameAncestors(hostHeader, dashboardPort) {
  const name = hostName(hostHeader);
  const port = Number(dashboardPort);
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return "'none'";
  return `'self' http://${name}:${port} https://${name}:${port}`;
}

/**
 * A browser POST or WebSocket names its origin. The OpenCode document is this
 * embed, so that origin must be the embed host. A request with no Origin
 * (curl, the iframe navigation) still has to pass the dashboard token check.
 * @param {string | undefined} origin
 * @param {string | undefined} hostHeader
 */
export function originAllowed(origin, hostHeader) {
  if (origin == null || origin === "") return true;
  const presented = String(origin).trim().toLowerCase();
  if (presented === "null") return false;
  const host = String(hostHeader || "").trim().toLowerCase();
  return Boolean(host) && (presented === `http://${host}` || presented === `https://${host}`);
}

/**
 * @param {import("http").IncomingHttpHeaders} headers
 * @param {string} hostHeader
 * @param {string | null} auth
 */
export function forwardRequestHeaders(headers, hostHeader, auth) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (REQUEST_DROP.has(lower)) continue;
    if (lower.startsWith("sec-websocket")) continue;
    if (value == null) continue;
    out[key] = value;
  }
  out.Host = hostHeader;
  out.Connection = "close";
  if (auth) out.Authorization = auth;
  return out;
}

/**
 * @param {string} policy
 * @param {string} directive
 */
function mergeFrameAncestors(policy, directive) {
  const text = String(policy)
    .replace(/frame-ancestors[^;]*/gi, "")
    .replace(/;\s*;/g, ";")
    .trim()
    .replace(/;$/, "")
    .trim();
  return text ? `${text}; ${directive}` : directive;
}

/**
 * @param {import("http").IncomingHttpHeaders} headers
 * @param {{ frameAncestors?: string }} [opts]
 */
export function forwardResponseHeaders(headers, opts = {}) {
  /** @type {Record<string, string | string[] | number>} */
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (RESPONSE_DROP.has(lower) || value == null) continue;
    if (lower === "x-frame-options") continue;
    if (lower === "set-cookie") {
      const list = (Array.isArray(value) ? value : [value]).filter((cookie) => {
        const name = String(cookie).split("=", 1)[0].trim().toLowerCase();
        return name !== "sparkdash_agent" && name !== "dashboard_session";
      });
      if (list.length) out["set-cookie"] = list;
      continue;
    }
    out[key] = value;
  }
  if (opts.frameAncestors) {
    const directive = `frame-ancestors ${opts.frameAncestors}`;
    const cspKey = Object.keys(out).find((key) => key.toLowerCase() === "content-security-policy");
    if (!cspKey) out["Content-Security-Policy"] = directive;
    else if (Array.isArray(out[cspKey])) out[cspKey] = out[cspKey].map((item) => mergeFrameAncestors(String(item), directive));
    else out[cspKey] = mergeFrameAncestors(String(out[cspKey]), directive);
  }
  out["X-Content-Type-Options"] = "nosniff";
  out["Referrer-Policy"] = "no-referrer";
  out["Cache-Control"] = out["Cache-Control"] || out["cache-control"] || "no-store";
  return out;
}

/**
 * @param {{ host: string, port: number }} target
 * @param {string} path
 * @param {string | null} auth
 * @param {number} [timeoutMs]
 */
function getLimited(target, path, auth, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        method: "GET",
        path,
        headers: {
          Host: `${target.host}:${target.port}`,
          Accept: "application/json",
          Connection: "close",
          ...(auth ? { Authorization: auth } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 4096) chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {string} raw
 */
function parseHealthJson(raw) {
  try {
    const data = JSON.parse(raw || "null");
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Try OpenCode v2 `/api/info`, then v1 `/global/health`.
 * @param {{ host: string, port: number }} target
 * @param {string | null} auth
 */
export async function probeHealth(target, auth) {
  let info;
  try {
    info = await getLimited(target, "/api/info", auth);
  } catch {
    return { healthy: false, version: null, error: "OpenCode on uba is not reachable" };
  }
  if (info.status === 401) {
    return {
      healthy: false,
      version: null,
      error: auth ? "upstream credentials refused" : "upstream requires Basic credentials",
    };
  }
  if (info.status === 200) {
    const data = parseHealthJson(info.body);
    if (data && (data.version || data.pid)) {
      const version = typeof data.version === "string" ? data.version : null;
      return { healthy: Boolean(data.version && data.pid), version, error: null };
    }
  }
  let health;
  try {
    health = await getLimited(target, "/global/health", auth);
  } catch {
    return { healthy: false, version: null, error: "OpenCode on uba is not reachable" };
  }
  if (health.status === 401) {
    return {
      healthy: false,
      version: null,
      error: auth ? "upstream credentials refused" : "upstream requires Basic credentials",
    };
  }
  if (health.status !== 200) {
    return { healthy: false, version: null, error: info.status ? `HTTP ${info.status}` : "OpenCode on uba is not reachable" };
  }
  const data = parseHealthJson(health.body);
  if (!data) return { healthy: false, version: null, error: "OpenCode health response was not JSON" };
  return {
    healthy: Boolean(data.healthy),
    version: typeof data.version === "string" ? data.version : null,
    error: data.healthy ? null : "OpenCode reported that it is not healthy",
  };
}

/**
 * @param {import("http").IncomingMessage} req
 */
function readBody(req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return Promise.resolve(Buffer.alloc(0));
  if (req.headers["transfer-encoding"]) {
    const err = new Error("length required");
    err.status = 411;
    return Promise.reject(err);
  }
  const raw = req.headers["content-length"];
  const length = raw == null || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(length) || length < 0) {
    const err = new Error("bad content length");
    err.status = 400;
    return Promise.reject(err);
  }
  if (length > MAX_BODY) {
    const err = new Error("body too large");
    err.status = 413;
    return Promise.reject(err);
  }
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    req.on("data", (chunk) => {
      got += chunk.length;
      if (got > length) {
        const err = new Error("bad content length");
        err.status = 400;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{ host: string, port: number }} target
 * @param {string | null} auth
 * @param {string} path
 * @param {(res: import("express").Response, status: number, body: object) => void} sendError
 * @param {{ frameAncestors?: string }} [opts]
 */
export async function proxyHttp(req, res, target, auth, path, sendError, opts = {}) {
  const method = (req.method || "GET").toUpperCase();
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 400;
    sendError(res, status, { error: err instanceof Error ? err.message : "bad request" });
    return;
  }
  const headers = forwardRequestHeaders(req.headers, `${target.host}:${target.port}`, auth);
  if (body.length || method === "POST" || method === "PUT" || method === "PATCH") {
    headers["Content-Length"] = String(body.length);
  }
  await new Promise((resolve) => {
    const upstreamReq = http.request(
      {
        host: target.host,
        port: target.port,
        method,
        path,
        headers,
        timeout: CONNECT_TIMEOUT_MS,
      },
      (upstreamRes) => {
        upstreamReq.setTimeout(0);
        const headersOut = forwardResponseHeaders(upstreamRes.headers, { frameAncestors: opts.frameAncestors });
        const fail = () => {
          if (!res.headersSent) res.destroy();
          else res.destroy();
          resolve();
        };
        upstreamRes.on("error", fail);
        if (/text\/event-stream/i.test(String(upstreamRes.headers["content-type"] || ""))) {
          headersOut["Cache-Control"] = "no-cache";
          headersOut["X-Accel-Buffering"] = "no";
        }
        res.writeHead(upstreamRes.statusCode || 502, headersOut);
        if (method === "HEAD") {
          res.end();
          upstreamRes.resume();
          resolve();
          return;
        }
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
      }
    );
    const giveUp = () => {
      if (!res.headersSent) sendError(res, 502, { error: "OpenCode on uba is not reachable" });
      else res.destroy();
      resolve();
    };
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("timeout")));
    upstreamReq.on("error", giveUp);
    res.on("close", () => upstreamReq.destroy());
    upstreamReq.end(body.length ? body : undefined);
  });
}
