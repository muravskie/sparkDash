/**
 * OpenRouter catalog and chat relay.
 *
 * The live list is GET https://openrouter.ai/api/v1/models (no key). Prices
 * there are USD per token; the playground catalog stores USD per 1M tokens.
 * Chat is the OpenAI-compatible /v1/chat/completions URL. The key stays on
 * the server, from OPENROUTER_API_KEY.
 */

import { chatPayload, proxyChatStream } from "./passthrough.js";
import { presentOpencodeGoModel } from "./opencodeGo.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_BASE = "https://openrouter.ai/api";
const USER_AGENT = "sparkdash/1.0";
const CACHE_MS = 5 * 60 * 1000;
const MODEL_ID = /^~?[A-Za-z0-9][A-Za-z0-9._:/-]{0,180}$/;

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
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadOpenRouterKey(env = process.env) {
  const direct = clean(env.OPENROUTER_API_KEY);
  if (headerSafe(direct)) return { key: direct, error: null };
  return { key: null, error: "OpenRouter API key is not configured" };
}

/**
 * OpenRouter quotes a decimal string of USD per token.
 * @param {unknown} raw
 */
function perMillion(raw) {
  if (raw == null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000 * 1e8) / 1e8;
}

/**
 * @param {object | null | undefined} pricing
 */
function costFromPricing(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input == null || output == null) return null;
  /** @type {{ input: number, output: number, cache_read?: number, cache_write?: number }} */
  const cost = { input, output };
  const cacheRead = perMillion(pricing.input_cache_read);
  const cacheWrite = perMillion(pricing.input_cache_write);
  if (cacheRead) cost.cache_read = cacheRead;
  if (cacheWrite) cost.cache_write = cacheWrite;
  return cost;
}

/**
 * @param {object} item
 */
function infoFrom(item) {
  const params = new Set(Array.isArray(item.supported_parameters) ? item.supported_parameters : []);
  const inputs = item.architecture?.input_modalities;
  return {
    name: typeof item.name === "string" ? item.name : undefined,
    tool_call: params.has("tools"),
    reasoning: params.has("reasoning") || params.has("include_reasoning") || Boolean(item.reasoning),
    structured_output: params.has("structured_outputs"),
    modalities: { input: Array.isArray(inputs) ? inputs : [] },
    limit: { context: item.context_length },
    cost: costFromPricing(item.pricing),
  };
}

/**
 * @param {object} item
 */
function chatsInText(item) {
  const outputs = item?.architecture?.output_modalities;
  if (!Array.isArray(outputs) || outputs.length === 0) return true;
  return outputs.includes("text");
}

/**
 * @param {{ data?: object[] } | null | undefined} live
 */
export function buildOpenRouterCatalog(live) {
  const data = Array.isArray(live?.data) ? live.data : [];
  const rows = [];
  for (const item of data) {
    const id = item?.id;
    if (typeof id !== "string" || !MODEL_ID.test(id) || !chatsInText(item)) continue;
    rows.push(presentOpencodeGoModel(id, infoFrom(item)));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return rows;
}

export function clearOpenRouterCache() {
  catalogCache = null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openRouterBase(env = process.env) {
  const configured = clean(env.OPENROUTER_BASE_URL);
  return (configured || DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * @param {{ fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, now?: number, refresh?: boolean }} [opts]
 */
export async function loadOpenRouterCatalog(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let models = !opts.refresh && catalogCache && now >= catalogCache.at && now - catalogCache.at < CACHE_MS ? catalogCache.models : null;
  if (!models) {
    const liveRes = await fetchImpl(`${openRouterBase(env)}/v1/models`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!liveRes.ok) throw fail("OpenRouter model list is unavailable", 502);
    models = buildOpenRouterCatalog(await liveRes.json());
    if (!opts.fetchImpl) catalogCache = { at: now, models };
  }
  const key = loadOpenRouterKey(env);
  return {
    provider: "openrouter",
    credential: Boolean(key.key),
    models,
  };
}

/**
 * Drop engine-only fields. A reasoning effort set for a local template is
 * sent as the OpenAI field OpenRouter models accept.
 *
 * @param {unknown} body
 */
export function openRouterChatBody(body) {
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
 * }} opts
 */
export async function handleOpenRouterStream(opts) {
  const env = opts.env || process.env;
  const loaded = loadOpenRouterKey(env);
  if (!loaded.key) throw fail(loaded.error || "OpenRouter API key is not configured", 503);
  const modelId = typeof opts.body?.modelId === "string" ? opts.body.modelId.trim() : "";
  if (!MODEL_ID.test(modelId)) throw fail("Choose an OpenRouter model", 400);
  await proxyChatStream({
    res: opts.res,
    baseUrl: openRouterBase(env),
    apiKey: loaded.key,
    engine: null,
    modelId,
    body: openRouterChatBody(opts.body),
    signal: opts.signal,
    extraHeaders: {
      "User-Agent": USER_AGENT,
      "X-Title": "sparkDash",
    },
  });
}
