/**
 * OpenCode Go catalog and chat relay.
 *
 * The live list is GET https://opencode.ai/inference/go/v1/models (no key).
 * That payload is only ids. Names, features, and per-1M prices are joined from
 * the OpenCode catalog at models.dev. Chat is the OpenAI-compatible
 * /v1/chat/completions URL, which answers 401 "Go requires a credential"
 * until a key, a non-generic user agent, and x-opencode-session are present.
 * Models that reject that protocol are translated in goProtocols.js. The
 * first-byte wait is capped at 300s because a throttled
 * Go request otherwise sits until Cloudflare returns 524.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "undici";
import { goProtocol, proxyAdaptedGoStream } from "./goProtocols.js";
import { chatPayload, proxyChatStream } from "./passthrough.js";

export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
export const OPENCODE_GO_CATALOG_URL = "https://models.dev/api.json";
export const OPENCODE_GO_USER_AGENT = "sparkdash/1.0";
const DEFAULT_BASE = "https://opencode.ai/inference/go";
const CACHE_MS = 5 * 60 * 1000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,128}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,128}$/;

const goDispatcher = new Agent({
  headersTimeout: 300_000,
  bodyTimeout: 0,
});

/** @type {{ at: number, models: object[] } | null} */
let catalogCache = null;

/**
 * @param {string} value
 */
function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} value
 */
function headerSafe(value) {
  return value.length > 0 && value.length < 4096 && !/[\r\n]/.test(value);
}

/**
 * @param {string} message
 * @param {number} status
 */
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * @param {unknown} entry
 */
function tokenFromEntry(entry) {
  if (typeof entry === "string") return headerSafe(entry.trim()) ? entry.trim() : "";
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  for (const key of ["access", "token", "apiKey", "key"]) {
    const value = entry[key];
    if (typeof value === "string" && headerSafe(value.trim())) return value.trim();
  }
  return "";
}

/**
 * @param {string} file
 * @param {{ statSync?: typeof fs.statSync, readFileSync?: typeof fs.readFileSync }} io
 */
function readKeyFile(file, io) {
  let stat;
  try {
    stat = io.statSync(file);
  } catch {
    return { key: null, error: "OpenCode Go key file is not readable" };
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    return { key: null, error: "OpenCode Go key file must be mode 600" };
  }
  let text;
  try {
    text = io.readFileSync(file, "utf8");
  } catch {
    return { key: null, error: "OpenCode Go key file is not readable" };
  }
  const key = String(text).trim();
  if (!headerSafe(key)) return { key: null, error: "OpenCode Go key file is empty" };
  return { key, error: null };
}

/**
 * GO-LEARN names opencode-go-console in ~/.pi/agent/auth.json. That entry is
 * absent on this host today; the reader still accepts it when it appears.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ statSync?: typeof fs.statSync, readFileSync?: typeof fs.readFileSync, existsSync?: typeof fs.existsSync }} io
 */
function readLegacyAuth(env, io) {
  const configured = clean(env.OPENCODE_GO_AUTH_FILE);
  const file = configured || path.join(os.homedir(), ".pi", "agent", "auth.json");
  if (!configured && !io.existsSync(file)) return "";
  let text;
  try {
    text = io.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return "";
  }
  if (!data || typeof data !== "object") return "";
  return tokenFromEntry(data["opencode-go-console"]);
}

/**
 * Console auth login stores an OAuth access token in OpenCode's database.
 * The dashboard container sees the host copy through HOST_ROOT_PATH.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ existsSync?: typeof fs.existsSync, readdirSync?: typeof fs.readdirSync, statSync?: typeof fs.statSync }} io
 */
function opencodeDbPaths(env, io) {
  /** @type {string[]} */
  const found = [];
  const add = (file) => {
    if (!file || found.includes(file)) return;
    try {
      if (io.existsSync(file)) found.push(file);
    } catch {
      /* skip unreadable parents */
    }
  };
  const configured = clean(env.OPENCODE_DB);
  if (configured) {
    add(configured);
    return found;
  }
  add(path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"));
  const root = clean(env.HOST_ROOT_PATH);
  if (!root || !io.readdirSync) return found;
  add(path.join(root, "root", ".local", "share", "opencode", "opencode.db"));
  try {
    for (const name of io.readdirSync(path.join(root, "home"))) {
      add(path.join(root, "home", name, ".local", "share", "opencode", "opencode.db"));
    }
  } catch {
    /* no host home directory */
  }
  return found;
}

/**
 * @param {string} file
 * @returns {{ key: string } | { expired: true } | null}
 */
function readOpencodeDbFile(file) {
  /** @type {InstanceType<typeof DatabaseSync> | undefined} */
  let db;
  try {
    const href = pathToFileURL(file).href;
    db = new DatabaseSync(`${href}?mode=ro`, { readOnly: true });
    const row = db.prepare(
      "SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1 ORDER BY time_updated DESC LIMIT 1",
    ).get();
    if (!row || typeof row.value !== "string") return null;
    const data = JSON.parse(row.value);
    const access = typeof data?.access === "string" ? data.access.trim() : "";
    if (!headerSafe(access)) return null;
    const expires = Number(data?.expires);
    if (Number.isFinite(expires) && expires > 0) {
      const ms = expires < 1e12 ? expires * 1000 : expires;
      if (ms < Date.now() - 30_000) return { expired: true };
    }
    return { key: access };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ existsSync?: typeof fs.existsSync, readdirSync?: typeof fs.readdirSync, statSync?: typeof fs.statSync }} io
 */
function readOpencodeConsole(env, io) {
  const paths = opencodeDbPaths(env, io).sort((a, b) => {
    try {
      return io.statSync(b).mtimeMs - io.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  let expired = false;
  for (const file of paths) {
    const found = readOpencodeDbFile(file);
    if (found && "key" in found) return { key: found.key, error: null };
    if (found && "expired" in found) expired = true;
  }
  if (expired) return { key: null, error: "OpenCode console login expired. Run console auth login again." };
  return null;
}

/**
 * The console token stays on the server. An explicit key or key file wins,
 * then the OpenCode console login database, then the older Pi auth entry.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ statSync?: typeof fs.statSync, readFileSync?: typeof fs.readFileSync, existsSync?: typeof fs.existsSync, readdirSync?: typeof fs.readdirSync }} [io]
 */
export function loadOpencodeGoKey(env = process.env, io = fs) {
  for (const name of ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]) {
    const direct = clean(env[name]);
    if (headerSafe(direct)) return { key: direct, error: null };
  }
  const file = clean(env.OPENCODE_GO_KEY_FILE);
  if (file) return readKeyFile(file, io);
  // A stubbed filesystem must not open the real host database.
  if (io === fs || clean(env.OPENCODE_DB)) {
    const consoleLogin = readOpencodeConsole(env, io);
    if (consoleLogin?.key || consoleLogin?.error) return consoleLogin;
  }
  const legacy = readLegacyAuth(env, io);
  if (legacy) return { key: legacy, error: null };
  return { key: null, error: "OpenCode Go API key is not configured" };
}

/**
 * @param {number} n
 */
function money(n) {
  const precise = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = precise.includes(".") ? precise.split(".")[1].length : 0;
  return decimals <= 2 ? `$${n.toFixed(2)}` : `$${precise}`;
}

/**
 * @param {number | undefined} n
 */
function contextLabel(n) {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${text}M ctx`;
  }
  return `${Math.round(n / 1000)}K ctx`;
}

/**
 * @param {object | null | undefined} info
 */
function capabilityLabels(info) {
  /** @type {string[]} */
  const features = [];
  if (info?.tool_call) features.push("tools");
  if (info?.reasoning) features.push("reasoning");
  if (info?.structured_output) features.push("structured");
  const inputs = info?.modalities?.input;
  if (Array.isArray(inputs)) {
    if (inputs.includes("image")) features.push("vision");
    if (inputs.includes("audio")) features.push("audio");
    if (inputs.includes("video")) features.push("video");
  }
  return features;
}

/**
 * @param {object | null | undefined} info
 */
function featuresOf(info) {
  const features = capabilityLabels(info);
  const context = contextLabel(info?.limit?.context);
  if (context) features.push(context);
  return features;
}

/**
 * Context size without the "ctx" suffix, for the model table column.
 * @param {number | undefined} n
 */
function contextCell(n) {
  const label = contextLabel(n);
  return label ? label.replace(/ ctx$/, "") : null;
}

/**
 * @param {object | null | undefined} cost
 */
export function publicCost(cost) {
  if (!cost || typeof cost !== "object") return null;
  const input = cost.input;
  const output = cost.output;
  if (typeof input !== "number" || !Number.isFinite(input) || typeof output !== "number" || !Number.isFinite(output)) return null;
  /** @type {{ input: number, output: number, cache_read?: number, cache_write?: number }} */
  const out = { input, output };
  if (typeof cost.cache_read === "number" && Number.isFinite(cost.cache_read)) out.cache_read = cost.cache_read;
  if (typeof cost.cache_write === "number" && Number.isFinite(cost.cache_write)) out.cache_write = cost.cache_write;
  return out;
}

/**
 * @param {object | null | undefined} cost
 */
export function priceLabel(cost) {
  const priced = publicCost(cost);
  if (!priced) return null;
  const cacheRead = priced.cache_read ?? 0;
  const cacheWrite = priced.cache_write ?? 0;
  if (priced.input === 0 && priced.output === 0 && cacheRead === 0 && cacheWrite === 0) return "free";
  const parts = [`${money(priced.input)} in`, `${money(priced.output)} out`];
  if (cacheRead > 0) parts.push(`${money(cacheRead)} cache`);
  if (cacheWrite > 0) parts.push(`${money(cacheWrite)} cache write`);
  return `${parts.join(" / ")} per 1M`;
}

/**
 * @param {string} id
 * @param {object} info
 */
export function presentOpencodeGoModel(id, info = {}) {
  const name = typeof info.name === "string" && info.name.trim() ? info.name.trim() : id;
  const features = featuresOf(info);
  const price = priceLabel(info.cost);
  return {
    id,
    name,
    features: capabilityLabels(info),
    context: contextCell(info?.limit?.context),
    line: [name, features.length ? features.join(", ") : null, price].filter(Boolean).join(" · "),
    cost: publicCost(info.cost),
  };
}

/**
 * Live ids win. Catalog metadata fills the line. Ids that are only in the
 * catalog are omitted, and live ids with no metadata stay as the bare id.
 *
 * @param {{ data?: { id?: string }[] } | null | undefined} live
 * @param {Record<string, object> | null | undefined} metadata
 */
export function buildOpencodeGoCatalog(live, metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const rows = [];
  const data = Array.isArray(live?.data) ? live.data : [];
  for (const item of data) {
    const id = item?.id;
    if (typeof id !== "string" || !MODEL_ID.test(id)) continue;
    rows.push(presentOpencodeGoModel(id, meta[id] || {}));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return rows;
}

export function clearOpencodeGoCache() {
  catalogCache = null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function opencodeGoBase(env = process.env) {
  const configured = clean(env.OPENCODE_GO_BASE_URL);
  return (configured || DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * @param {{ fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, io?: typeof fs, now?: number }} [opts]
 */
export async function loadOpencodeGoCatalog(opts = {}) {
  const env = opts.env || process.env;
  const io = opts.io || fs;
  const now = opts.now || Date.now();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let models = catalogCache && now - catalogCache.at < CACHE_MS ? catalogCache.models : null;
  if (!models) {
    const liveRes = await fetchImpl(OPENCODE_GO_MODELS_URL, {
      headers: { Accept: "application/json", "User-Agent": OPENCODE_GO_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!liveRes.ok) throw fail("OpenCode Go model list is unavailable", 502);
    const live = await liveRes.json();
    /** @type {Record<string, object>} */
    let metadata = {};
    try {
      const catalogRes = await fetchImpl(OPENCODE_GO_CATALOG_URL, {
        headers: { Accept: "application/json", "User-Agent": OPENCODE_GO_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (catalogRes.ok) {
        const catalog = await catalogRes.json();
        const modelsById = catalog?.["opencode-go"]?.models;
        if (modelsById && typeof modelsById === "object") metadata = modelsById;
      }
    } catch {
      metadata = {};
    }
    models = buildOpencodeGoCatalog(live, metadata);
    if (!opts.fetchImpl) catalogCache = { at: now, models };
  }
  const key = loadOpencodeGoKey(env, io);
  return {
    provider: "opencode-go",
    credential: Boolean(key.key),
    models,
  };
}

/**
 * Drop engine-only fields. A reasoning effort set for a local template is
 * sent as the OpenAI field Go models accept.
 *
 * @param {unknown} body
 */
export function goChatBody(body) {
  const payload = chatPayload(body);
  delete payload.thinking_budget;
  delete payload.thinking_token_budget;
  const kwargs = payload.chat_template_kwargs;
  if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)) {
    if (payload.reasoning_effort == null && typeof kwargs.reasoning_effort === "string") {
      payload.reasoning_effort = kwargs.reasoning_effort;
    }
  }
  delete payload.chat_template_kwargs;
  return payload;
}

/**
 * @param {{
 *   res: import("express").Response,
 *   body: object,
 *   signal: AbortSignal,
 *   env?: NodeJS.ProcessEnv,
 *   io?: typeof fs,
 * }} opts
 */
export async function handleOpencodeGoStream(opts) {
  const env = opts.env || process.env;
  const loaded = loadOpencodeGoKey(env, opts.io || fs);
  if (!loaded.key) throw fail(loaded.error || "OpenCode Go API key is not configured", 503);
  const modelId = typeof opts.body?.modelId === "string" ? opts.body.modelId.trim() : "";
  if (!MODEL_ID.test(modelId)) throw fail("Choose an OpenCode Go model", 400);
  const sessionId = typeof opts.body?.sessionId === "string" ? opts.body.sessionId.trim() : "";
  if (!SESSION_ID.test(sessionId)) throw fail("OpenCode Go requires a conversation session", 400);
  const extraHeaders = {
    "User-Agent": OPENCODE_GO_USER_AGENT,
    "x-opencode-session": sessionId,
  };
  const stream = {
    res: opts.res,
    baseUrl: opencodeGoBase(env),
    apiKey: loaded.key,
    modelId,
    body: goChatBody(opts.body),
    signal: opts.signal,
    extraHeaders,
    dispatcher: goDispatcher,
  };
  if (goProtocol(modelId) === "chat") {
    await proxyChatStream({ ...stream, engine: null });
    return;
  }
  await proxyAdaptedGoStream(stream);
}
