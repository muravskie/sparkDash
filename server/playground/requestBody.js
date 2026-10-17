/**
 * Build the OpenAI chat-completions body the playground relays.
 * Blank sampling fields are omitted. Fields the engine does not accept are omitted.
 */

import { applyThinkingFlags } from "../collectors/LlmStreaming.js";

/**
 * @param {string} message
 * @param {number} status
 */
function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function optionalNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function optionalInt(raw) {
  const n = optionalNumber(raw);
  if (n == null || !Number.isInteger(n)) return null;
  return n;
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function parseConcurrency(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw fail("concurrency must be an integer from 1 to 8");
  }
  return n;
}

/**
 * Drop a trailing assistant turn so a replay regenerates the reply.
 * @param {unknown[]} messages
 */
export function messagesForReplay(messages) {
  const copy = Array.isArray(messages) ? messages.slice() : [];
  while (copy.length && copy[copy.length - 1] && copy[copy.length - 1].role === "assistant") {
    copy.pop();
  }
  return copy;
}

/**
 * @param {Record<string, { enabled?: boolean }> | null | undefined} accepted
 * @param {string} key
 */
function allows(accepted, key) {
  if (!accepted || !accepted[key]) return true;
  return accepted[key].enabled !== false;
}

/**
 * @param {unknown} message
 * @returns {Record<string, unknown> | null}
 */
function toOpenAiMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = message.role;
  if (role === "system" || role === "user") {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) return null;
    return { role, content };
  }
  if (role === "tool") {
    const id = message.toolCallId ?? message.tool_call_id;
    if (typeof id !== "string" || !id.trim()) throw fail("A tool result needs a tool call id");
    /** @type {Record<string, unknown>} */
    const out = {
      role: "tool",
      tool_call_id: id.trim(),
      content: typeof message.content === "string" ? message.content : "",
    };
    if (typeof message.name === "string" && message.name.trim()) out.name = message.name.trim();
    return out;
  }
  if (role === "assistant") {
    const content = typeof message.content === "string" ? message.content : "";
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    /** @type {Record<string, unknown>} */
    const out = { role: "assistant", content: content.length ? content : calls.length ? null : "" };
    if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
      out.reasoning_content = message.reasoning;
    }
    if (calls.length) {
      out.tool_calls = calls.map((call, index) => {
        const id = typeof call?.id === "string" && call.id.trim() ? call.id.trim() : `call_${index}`;
        return {
          id,
          type: "function",
          function: {
            name: typeof call?.name === "string" ? call.name : "",
            arguments: typeof call?.arguments === "string" ? call.arguments : "",
          },
        };
      });
    }
    if (!content && !out.reasoning_content && !calls.length) return null;
    return out;
  }
  return null;
}

/**
 * @param {{
 *   modelId?: string | null,
 *   messages: unknown[],
 *   sampling?: Record<string, unknown> | null,
 *   tools?: unknown,
 *   accepted?: Record<string, { enabled?: boolean }> | null,
 * }} input
 */
export function buildChatBody(input) {
  const rawMessages = input?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw fail("messages are required");
  if (rawMessages.length > 80) throw fail("Too many messages");

  let chars = 0;
  const messages = [];
  for (const message of rawMessages) {
    const converted = toOpenAiMessage(message);
    if (!converted) continue;
    chars += JSON.stringify(converted).length;
    if (chars > 400_000) throw fail("Conversation is too large");
    messages.push(converted);
  }
  if (!messages.length) throw fail("messages are required");

  /** @type {Record<string, unknown>} */
  const body = { messages, stream: true };
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  if (modelId) body.model = modelId;

  const sampling = input.sampling && typeof input.sampling === "object" ? input.sampling : {};
  const accepted = input.accepted;

  const putNumber = (field, wire, { integer = false, min = null } = {}) => {
    if (!allows(accepted, field)) return;
    const n = integer ? optionalInt(sampling[field]) : optionalNumber(sampling[field]);
    if (n == null) return;
    if (min != null && n < min) return;
    body[wire] = n;
  };

  putNumber("temperature", "temperature", { min: 0 });
  putNumber("topP", "top_p");
  putNumber("topK", "top_k", { integer: true, min: 0 });
  putNumber("maxTokens", "max_tokens", { integer: true, min: 1 });
  putNumber("presencePenalty", "presence_penalty");

  if (allows(accepted, "thinking")) {
    if (sampling.thinking === "on" || sampling.thinking === true) applyThinkingFlags(body, modelId, true);
    else if (sampling.thinking === "off" || sampling.thinking === false) applyThinkingFlags(body, modelId, false);
  }

  if (allows(accepted, "reasoningEffort")) {
    const effort = typeof sampling.reasoningEffort === "string" ? sampling.reasoningEffort.trim() : "";
    if (effort && /^[A-Za-z0-9._-]{1,32}$/.test(effort)) body.reasoning_effort = effort;
  }

  if (allows(accepted, "thinkingBudget")) {
    const budget = optionalInt(sampling.thinkingBudget);
    if (budget != null && budget > 0) {
      body.reasoning_budget = budget;
      const kwargs =
        body.chat_template_kwargs && typeof body.chat_template_kwargs === "object"
          ? { ...body.chat_template_kwargs }
          : {};
      kwargs.thinking_budget = budget;
      body.chat_template_kwargs = kwargs;
    }
  }

  if (Array.isArray(input.tools) && input.tools.length) {
    if (input.tools.length > 32) throw fail("Too many tools");
    body.tools = input.tools;
  }

  return body;
}
