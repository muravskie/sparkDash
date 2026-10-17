/**
 * Small reads of the engine's own info documents (props, model info, server info).
 * Sampling defaults come only from those documents.
 */

import { samplingProfile } from "./sampling.js";

/**
 * @param {string | null | undefined} backend
 * @returns {string[]}
 */
export function infoPaths(backend) {
  switch (backend) {
    case "llama.cpp":
      return ["/props"];
    case "sglang":
      return ["/model_info", "/server_info"];
    case "ollama":
      return [];
    case "vllm":
    case "lmstudio":
    case "exl3":
    case "ds4":
    case "q27":
    case "tensorfold":
    case "freetoken":
      return [];
    default:
      return ["/props", "/model_info"];
  }
}

/**
 * @param {string | null | undefined} apiKey
 */
function bearerHeaders(apiKey) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  const key = apiKey != null ? String(apiKey).trim() : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * @param {string} url
 * @param {{ apiKey?: string | null, signal?: AbortSignal, method?: string, body?: unknown }} opts
 */
async function readJson(url, opts) {
  const parent = opts.signal;
  const timeout = AbortSignal.timeout(5_000);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  const headers = bearerHeaders(opts.apiKey);
  /** @type {RequestInit} */
  const init = { method: opts.method || "GET", headers, signal, redirect: "error" };
  if (opts.body != null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.length > 2_000_000) return null;
  return JSON.parse(text);
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ apiKey?: string | null, signal?: AbortSignal, method?: string, body?: unknown }} opts
 */
export async function readEngineDocument(baseUrl, path, opts) {
  try {
    return await readJson(`${baseUrl}${path}`, opts);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return null;
  }
}

/**
 * First model id from an OpenAI /v1/models payload.
 * @param {unknown} doc
 * @returns {string | null}
 */
export function firstModelId(doc) {
  const data = doc && typeof doc === "object" ? doc.data : null;
  if (!Array.isArray(data)) return null;
  for (const row of data) {
    if (row && typeof row.id === "string" && row.id.trim()) return row.id.trim();
  }
  return null;
}

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey?: string | null,
 *   backend?: string | null,
 *   modelId?: string | null,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function readEngineContext(opts) {
  const backend = opts.backend || null;
  let modelId = typeof opts.modelId === "string" && opts.modelId.trim() ? opts.modelId.trim() : null;
  /** @type {unknown[]} */
  const docs = [];

  const fetched = await Promise.all(
    infoPaths(backend).map((path) => readEngineDocument(opts.baseUrl, path, opts))
  );
  for (const doc of fetched) {
    if (doc && typeof doc === "object") docs.push(doc);
  }

  if (!modelId) {
    const models = await readEngineDocument(opts.baseUrl, "/v1/models", opts);
    modelId = firstModelId(models);
  }

  if (backend === "ollama" && modelId) {
    const shown = await readEngineDocument(opts.baseUrl, "/api/show", {
      ...opts,
      method: "POST",
      body: { name: modelId },
    });
    if (shown && typeof shown === "object") docs.push(shown);
  }

  return {
    modelId,
    backend,
    controls: samplingProfile(backend, docs),
  };
}
