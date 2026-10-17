/**
 * Forward the playground's own chat body to the engine and pipe the SSE
 * bytes back. The copied page parses OpenAI chunks itself.
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT } from "../collectors/LlmStreaming.js";
import { readEngineDocument } from "./engineInfo.js";

const ROUTING_KEYS = new Set(["port", "host", "tls", "modelId", "provider", "sessionId"]);

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
 * @param {unknown} body
 */
export function chatPayload(body) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  if (!body || typeof body !== "object") return payload;
  for (const [key, value] of Object.entries(body)) {
    if (ROUTING_KEYS.has(key) || value === undefined) continue;
    payload[key] = value;
  }
  return payload;
}

/**
 * Put the thinking budget on the field that engine accepts.
 * @param {Record<string, unknown>} payload
 * @param {string | null | undefined} engine
 */
export function applyEngineBudget(payload, engine) {
  const budget = payload.thinking_budget;
  const vllmBudget = payload.thinking_token_budget;
  delete payload.thinking_budget;
  delete payload.thinking_token_budget;
  if (budget != null && vllmBudget != null) throw fail("Specify thinking budget in only one place", 422);
  const value = budget ?? vllmBudget;
  if (value == null) return;
  const resolved = engine || (vllmBudget != null ? "vllm" : "tensorfold");
  if (resolved !== "vllm" && resolved !== "tensorfold") throw fail("Thinking budget is not enabled for this engine", 422);
  if (!Number.isInteger(value) || value < 0 || value > 262144) throw fail("Thinking budget must be an integer from 0 to 262144", 422);
  if (resolved === "tensorfold" && value === 0) {
    throw fail("TensorFold thinking budget must be at least 1; disable Thinking to skip reasoning", 422);
  }
  payload[resolved === "vllm" ? "thinking_token_budget" : "thinking_budget"] = value;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string | null | undefined} engine
 */
export function applyPresence(payload, engine) {
  if (engine === "tensorfold" && payload.presence_penalty != null) {
    throw fail("Presence penalty is not supported by this TensorFold engine", 422);
  }
}

/**
 * @param {string} baseUrl
 * @param {string | null | undefined} apiKey
 * @param {string | null | undefined} engine
 * @param {Record<string, unknown>} payload
 * @param {AbortSignal} signal
 */
async function fitOutputBudget(baseUrl, apiKey, engine, payload, signal) {
  if (engine !== "vllm" && engine !== "tensorfold") return {};
  const maxTokens = payload.max_tokens;
  if (engine === "vllm" && !(typeof maxTokens === "number" && maxTokens > 32768)) return {};
  /** @type {Record<string, unknown>} */
  const tokenize = { add_generation_prompt: true };
  for (const key of ["model", "messages", "chat_template_kwargs", "reasoning_effort", "tools", "tool_choice"]) {
    if (key in payload) tokenize[key] = payload[key];
  }
  const data = await readEngineDocument(baseUrl, "/tokenize", { apiKey, signal, method: "POST", body: tokenize });
  const prompt = data?.count;
  const context = data?.max_model_len;
  if (!Number.isInteger(prompt) || !Number.isInteger(context) || prompt < 0 || context <= 0) {
    throw fail("Cannot determine the engine context budget for this large output request", 503);
  }
  if (prompt >= context) {
    throw fail("Conversation fills the engine context window; start a new conversation or shorten it", 422);
  }
  payload.max_tokens = Math.min(Number(maxTokens), context - prompt);
  return {
    "X-Effective-Max-Tokens": String(payload.max_tokens),
    "X-Prompt-Tokens": String(prompt),
    "X-Context-Tokens": String(context),
  };
}

/**
 * @param {{
 *   res: import("express").Response,
 *   baseUrl: string,
 *   apiKey?: string | null,
 *   engine?: string | null,
 *   modelId?: string | null,
 *   body: unknown,
 *   signal: AbortSignal,
 *   extraHeaders?: Record<string, string>,
 *   dispatcher?: import("undici").Dispatcher,
 * }} opts
 */
export async function proxyChatStream(opts) {
  const payload = chatPayload(opts.body);
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) throw fail("messages are required", 400);
  if (!opts.modelId) throw fail("Cannot resolve served model", 503);
  delete payload.stream;
  delete payload.stream_options;
  payload.model = opts.modelId;
  payload.stream = true;
  payload.stream_options = { include_usage: true };
  applyEngineBudget(payload, opts.engine);
  applyPresence(payload, opts.engine);
  const budgetHeaders = await fitOutputBudget(opts.baseUrl, opts.apiKey, opts.engine, payload, opts.signal);

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  const upstream = await undiciFetch(`${opts.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
    dispatcher: opts.dispatcher || LLM_STREAM_AGENT,
  });
  if (!upstream.ok) {
    let text = await upstream.text().catch(() => "");
    if (opts.apiKey) text = text.split(opts.apiKey).join("[redacted]");
    if (!opts.res.headersSent) {
      opts.res.status(upstream.status);
      opts.res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/plain; charset=utf-8");
      opts.res.send(text.slice(0, 65536));
    }
    return;
  }
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.startsWith("text/event-stream") || !upstream.body) {
    throw fail("Inference endpoint did not return an event stream", 502);
  }
  opts.res.status(200);
  opts.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  opts.res.setHeader("Cache-Control", "no-store");
  opts.res.setHeader("X-Accel-Buffering", "no");
  for (const [key, value] of Object.entries(budgetHeaders)) opts.res.setHeader(key, value);
  if (typeof opts.res.flushHeaders === "function") opts.res.flushHeaders();
  await pipeline(Readable.fromWeb(upstream.body), opts.res);
}
