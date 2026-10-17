/**
 * OpenCode Go protocols other than Chat Completions.
 *
 * The playground reads OpenAI chat chunks. These adapters rewrite one chat
 * body into the family's request and turn that family's stream back into
 * those chunks. Ids the live gateway already answers on Chat Completions,
 * including Qwen and MiniMax M3, stay on that path.
 */

import { fetch as undiciFetch } from "undici";

const RESPONSES = new Set([
  "grok-4.6",
  "grok-4.7",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
]);

const ANTHROPIC = new Set([
  "claude-haiku-5-5",
  "minimax-m2.7",
]);

const GOOGLE = new Set([
  "gemini-4-argon-contributor",
]);

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
 * @param {string} modelId
 * @returns {"chat" | "responses" | "anthropic" | "google"}
 */
export function goProtocol(modelId) {
  if (RESPONSES.has(modelId)) return "responses";
  if (ANTHROPIC.has(modelId)) return "anthropic";
  if (GOOGLE.has(modelId)) return "google";
  return "chat";
}

/**
 * @param {unknown} value
 */
function count(value) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * @param {unknown} value
 */
function textOf(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((part) => textOf(part && typeof part === "object" ? part.text ?? part.content : part)).join("");
  if (typeof value === "object") return textOf(value.text ?? value.content ?? "");
  return String(value);
}

/**
 * @param {unknown} tools
 */
function functionTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return out;
}

/**
 * @param {unknown} body
 */
function messagesOf(body) {
  const messages = body && typeof body === "object" ? body.messages : null;
  if (!Array.isArray(messages) || messages.length === 0) throw fail("messages are required", 400);
  return messages;
}

/**
 * @param {unknown} body
 */
function outputLimit(body) {
  const n = body?.max_tokens;
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1) throw fail("max_tokens must be a positive integer", 400);
  return n;
}

/**
 * @param {unknown} body
 * @param {string} key
 */
function finite(body, key) {
  const n = body?.[key];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} usage
 */
export function openAiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = count(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount);
  const completion = count(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount);
  const total = count(usage.total_tokens ?? usage.totalTokenCount) ?? (prompt != null && completion != null ? prompt + completion : null);
  if (prompt == null && completion == null && total == null) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  if (prompt != null) out.prompt_tokens = prompt;
  if (completion != null) out.completion_tokens = completion;
  if (total != null) out.total_tokens = total;
  const reasoning = count(usage.output_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.thoughtsTokenCount);
  if (reasoning != null) out.completion_tokens_details = { reasoning_tokens: reasoning };
  const cached = count(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount);
  if (cached != null) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

/**
 * @param {Record<string, unknown>} [delta]
 * @param {string | null} [finish]
 * @param {Record<string, unknown> | null} [usage]
 */
function chatChunk(delta = {}, finish = null, usage = null) {
  /** @type {Record<string, unknown>} */
  const choice = { index: 0, delta };
  if (finish) choice.finish_reason = finish;
  /** @type {Record<string, unknown>} */
  const chunk = { choices: [choice] };
  if (usage) chunk.usage = usage;
  return chunk;
}

/**
 * @param {unknown} body
 * @param {string} modelId
 */
function responsesRequest(body, modelId) {
  const messages = messagesOf(body);
  /** @type {string[]} */
  const instructions = [];
  /** @type {object[]} */
  const input = [];
  for (const message of messages) {
    const role = message?.role;
    if (role === "system") {
      const text = textOf(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: String(message.tool_call_id || ""), output: textOf(message.content) });
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const text = textOf(message.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: String(call?.id || ""),
          name: String(call?.function?.name || ""),
          arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}",
        });
      }
      continue;
    }
    const text = textOf(message?.content);
    if (text) input.push({ role: role === "assistant" ? "assistant" : "user", content: text });
  }
  if (!input.length) throw fail("messages are required", 400);
  /** @type {Record<string, unknown>} */
  const payload = { model: modelId, input, stream: true };
  if (instructions.length) payload.instructions = instructions.join("\n\n");
  const limit = outputLimit(body);
  if (limit != null) payload.max_output_tokens = limit;
  const temperature = finite(body, "temperature");
  if (temperature != null) payload.temperature = temperature;
  const topP = finite(body, "top_p");
  if (topP != null) payload.top_p = topP;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort) payload.reasoning = { effort: body.reasoning_effort };
  const tools = functionTools(body.tools);
  if (tools.length) {
    payload.tools = tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  return payload;
}

/**
 * @param {unknown} message
 */
function anthropicBlocks(message) {
  /** @type {object[]} */
  const blocks = [];
  const text = textOf(message?.content);
  if (text) blocks.push({ type: "text", text });
  if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      let input = {};
      const raw = call?.function?.arguments;
      if (typeof raw === "string" && raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          input = parsed && typeof parsed === "object" ? parsed : { arguments: raw };
        } catch {
          input = { arguments: raw };
        }
      }
      blocks.push({ type: "tool_use", id: String(call?.id || ""), name: String(call?.function?.name || ""), input });
    }
  }
  if (message?.role === "tool") {
    return [{ type: "tool_result", tool_use_id: String(message.tool_call_id || ""), content: text }];
  }
  return blocks;
}

/**
 * @param {unknown} body
 * @param {string} modelId
 */
function anthropicRequest(body, modelId) {
  const limit = outputLimit(body);
  if (limit == null) throw fail("max_tokens must be a positive integer", 400);
  /** @type {string[]} */
  const system = [];
  /** @type {{ role: string, content: object[] }[]} */
  const messages = [];
  for (const message of messagesOf(body)) {
    if (message?.role === "system") {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    const blocks = anthropicBlocks(message);
    if (!blocks.length) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  if (!messages.length) throw fail("messages are required", 400);
  /** @type {Record<string, unknown>} */
  const payload = {
    model: modelId,
    max_tokens: limit,
    stream: true,
    messages: messages.map((message) => (
      message.content.length === 1 && message.content[0].type === "text"
        ? { role: message.role, content: message.content[0].text }
        : message
    )),
  };
  if (system.length) payload.system = system.join("\n\n");
  const temperature = finite(body, "temperature");
  if (temperature != null) payload.temperature = temperature;
  else {
    const topP = finite(body, "top_p");
    if (topP != null) payload.top_p = topP;
  }
  const tools = functionTools(body.tools);
  if (tools.length) {
    payload.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  return payload;
}

/**
 * @param {unknown} body
 * @param {string} _modelId
 */
function googleRequest(body, _modelId) {
  /** @type {string[]} */
  const system = [];
  /** @type {{ role: string, parts: object[] }[]} */
  const contents = [];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const message of messagesOf(body)) {
    if (message?.role === "system") {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message?.role === "assistant") {
      for (const call of message.tool_calls || []) {
        if (call?.id && call?.function?.name) names.set(String(call.id), String(call.function.name));
      }
    }
    /** @type {object[]} */
    const parts = [];
    if (message?.role === "tool") {
      const name = names.get(String(message.tool_call_id || "")) || "tool";
      parts.push({ functionResponse: { name, response: { result: textOf(message.content) } } });
    } else {
      const text = textOf(message?.content);
      if (text) parts.push({ text });
      if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          let args = {};
          const raw = call?.function?.arguments;
          if (typeof raw === "string" && raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              args = parsed && typeof parsed === "object" ? parsed : { arguments: raw };
            } catch {
              args = { arguments: raw };
            }
          }
          parts.push({ functionCall: { name: String(call?.function?.name || ""), args } });
        }
      }
    }
    if (!parts.length) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length) throw fail("messages are required", 400);
  /** @type {Record<string, unknown>} */
  const payload = { contents };
  if (system.length) payload.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  /** @type {Record<string, unknown>} */
  const generation = {};
  const limit = outputLimit(body);
  if (limit != null) generation.maxOutputTokens = limit;
  const temperature = finite(body, "temperature");
  if (temperature != null) generation.temperature = temperature;
  const topP = finite(body, "top_p");
  if (topP != null) generation.topP = topP;
  const topK = finite(body, "top_k");
  if (topK != null) generation.topK = topK;
  if (Object.keys(generation).length) payload.generationConfig = generation;
  const tools = functionTools(body.tools);
  if (tools.length) {
    payload.tools = [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
  }
  return payload;
}

/**
 * @param {string} modelId
 * @param {unknown} body
 */
export function buildGoRequest(modelId, body) {
  const protocol = goProtocol(modelId);
  if (protocol === "responses") {
    return { protocol, path: "/openai/v1/responses", headers: {}, body: responsesRequest(body, modelId) };
  }
  if (protocol === "anthropic") {
    return {
      protocol,
      path: "/anthropic/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: anthropicRequest(body, modelId),
    };
  }
  if (protocol === "google") {
    return {
      protocol,
      path: `/google/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
      headers: {},
      body: googleRequest(body, modelId),
    };
  }
  throw fail("Choose an OpenCode Go model", 400);
}

/**
 * @param {string} stop
 * @param {boolean} sawTool
 */
function anthropicFinish(stop, sawTool) {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use") return "tool_calls";
  if (stop === "refusal") return "content_filter";
  if (sawTool && stop === "end_turn") return "tool_calls";
  return "stop";
}

/**
 * @param {string | undefined} reason
 * @param {boolean} sawTool
 */
function googleFinish(reason, sawTool) {
  if (!reason) return null;
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST" || reason === "PROHIBITED_CONTENT" || reason === "SPII") return "content_filter";
  if (sawTool) return "tool_calls";
  return "stop";
}

/**
 * @param {"responses" | "anthropic" | "google"} protocol
 */
export function createGoTranslator(protocol) {
  if (protocol === "responses") return createResponsesTranslator();
  if (protocol === "anthropic") return createAnthropicTranslator();
  return createGoogleTranslator();
}

function createResponsesTranslator() {
  let finished = false;
  let sawTool = false;
  /** @type {Record<string, unknown> | null} */
  let usage = null;
  /** @type {Map<number | string, number>} */
  const tools = new Map();
  let nextTool = 0;
  return {
    /**
     * @param {Record<string, any>} data
     */
    push(data) {
      const type = data?.type;
      /** @type {object[]} */
      const chunks = [];
      if ((type === "response.output_text.delta" || type === "response.refusal.delta") && data.delta) {
        chunks.push(chatChunk({ content: String(data.delta) }));
      } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && data.delta) {
        chunks.push(chatChunk({ reasoning_content: String(data.delta) }));
      } else if (type === "response.output_item.added" && data.item?.type === "function_call") {
        sawTool = true;
        const index = nextTool++;
        tools.set(data.output_index ?? data.item.call_id ?? data.item.id, index);
        chunks.push(chatChunk({
          tool_calls: [{
            index,
            id: String(data.item.call_id || data.item.id || ""),
            type: "function",
            function: { name: String(data.item.name || ""), arguments: "" },
          }],
        }));
      } else if (type === "response.function_call_arguments.delta" && data.delta) {
        const index = tools.get(data.output_index) ?? 0;
        chunks.push(chatChunk({ tool_calls: [{ index, function: { arguments: String(data.delta) } }] }));
      } else if (type === "response.failed" || type === "error") {
        const message = data.response?.error?.message || data.error?.message || data.message || "OpenCode Go request failed";
        chunks.push({ error: { message: String(message) } });
      } else if (type === "response.completed" || type === "response.incomplete") {
        finished = true;
        usage = openAiUsage(data.response?.usage || data.usage) || usage;
        const status = data.response?.status;
        const reason = data.response?.incomplete_details?.reason;
        let finish = "stop";
        if (reason === "content_filter") finish = "content_filter";
        else if (reason === "max_output_tokens" || status === "incomplete" || type === "response.incomplete") finish = "length";
        else if (sawTool) finish = "tool_calls";
        chunks.push(chatChunk({}, finish, usage));
      }
      return chunks;
    },
    end() {
      if (finished) return [];
      finished = true;
      return [chatChunk({}, sawTool ? "tool_calls" : "stop", usage)];
    },
  };
}

function createAnthropicTranslator() {
  let finished = false;
  let sawTool = false;
  /** @type {Record<string, unknown>} */
  let usageRaw = {};
  /** @type {Map<number, number>} */
  const tools = new Map();
  let nextTool = 0;
  const usage = () => openAiUsage(usageRaw);
  return {
    /**
     * @param {Record<string, any>} data
     */
    push(data) {
      /** @type {object[]} */
      const chunks = [];
      if (data?.type === "message_start" && data.message?.usage) {
        usageRaw = { ...usageRaw, ...data.message.usage };
      } else if (data?.type === "content_block_start" && data.content_block?.type === "tool_use") {
        sawTool = true;
        const index = nextTool++;
        tools.set(data.index, index);
        chunks.push(chatChunk({
          tool_calls: [{
            index,
            id: String(data.content_block.id || ""),
            type: "function",
            function: { name: String(data.content_block.name || ""), arguments: "" },
          }],
        }));
      } else if (data?.type === "content_block_delta") {
        const delta = data.delta || {};
        if (delta.type === "text_delta" && delta.text) chunks.push(chatChunk({ content: String(delta.text) }));
        else if (delta.type === "thinking_delta" && delta.thinking) chunks.push(chatChunk({ reasoning_content: String(delta.thinking) }));
        else if (delta.type === "input_json_delta" && delta.partial_json) {
          const index = tools.get(data.index) ?? 0;
          chunks.push(chatChunk({ tool_calls: [{ index, function: { arguments: String(delta.partial_json) } }] }));
        }
      } else if (data?.type === "message_delta") {
        if (data.usage) usageRaw = { ...usageRaw, ...data.usage, output_tokens_details: data.usage.output_tokens_details || usageRaw.output_tokens_details };
        const stop = data.delta?.stop_reason;
        if (stop) {
          finished = true;
          chunks.push(chatChunk({}, anthropicFinish(stop, sawTool), usage()));
        }
      } else if (data?.type === "error") {
        chunks.push({ error: { message: String(data.error?.message || "OpenCode Go request failed") } });
      }
      return chunks;
    },
    end() {
      if (finished) return [];
      finished = true;
      return [chatChunk({}, sawTool ? "tool_calls" : "stop", usage())];
    },
  };
}

function createGoogleTranslator() {
  let finished = false;
  let sawTool = false;
  /** @type {Record<string, unknown> | null} */
  let usage = null;
  let nextTool = 0;
  return {
    /**
     * @param {Record<string, any>} data
     */
    push(data) {
      /** @type {object[]} */
      const chunks = [];
      if (data?.error?.message) {
        chunks.push({ error: { message: String(data.error.message) } });
        return chunks;
      }
      usage = openAiUsage(data?.usageMetadata) || usage;
      const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
      for (const part of candidate?.content?.parts || []) {
        if (part?.thought && part.text) chunks.push(chatChunk({ reasoning_content: String(part.text) }));
        else if (part?.text) chunks.push(chatChunk({ content: String(part.text) }));
        if (part?.functionCall) {
          sawTool = true;
          const index = nextTool++;
          const args = part.functionCall.args && typeof part.functionCall.args === "object" ? JSON.stringify(part.functionCall.args) : "";
          chunks.push(chatChunk({
            tool_calls: [{
              index,
              id: String(part.functionCall.id || `call_${index}`),
              type: "function",
              function: { name: String(part.functionCall.name || ""), arguments: args },
            }],
          }));
        }
      }
      const finish = googleFinish(candidate?.finishReason, sawTool);
      if (finish) {
        finished = true;
        chunks.push(chatChunk({}, finish, usage));
      }
      return chunks;
    },
    end() {
      if (finished) return [];
      finished = true;
      return [chatChunk({}, sawTool ? "tool_calls" : "stop", usage)];
    },
  };
}

/**
 * Incremental SSE framing that keeps the event name. A CRLF pair may split.
 */
export function createSseReader() {
  let buf = "";
  let event = "";
  /** @type {string[]} */
  let data = [];
  /**
   * @param {string} raw
   * @param {{ event: string, data: string }[]} out
   */
  const line = (raw, out) => {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (raw === "") {
      if (data.length || event) out.push({ event, data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (raw.startsWith(":")) return;
    if (raw.startsWith("event:")) event = raw.slice(6).trim();
    else if (raw.startsWith("data:")) data.push(raw.slice(5).replace(/^ /, ""));
  };
  return {
    /**
     * @param {string} text
     */
    feed(text) {
      buf += text;
      /** @type {{ event: string, data: string }[]} */
      const out = [];
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        line(buf.slice(0, nl), out);
        buf = buf.slice(nl + 1);
      }
      return out;
    },
    finish() {
      /** @type {{ event: string, data: string }[]} */
      const out = [];
      if (buf) line(buf, out);
      buf = "";
      if (data.length || event) out.push({ event, data: data.join("\n") });
      event = "";
      data = [];
      return out;
    },
  };
}

/**
 * @param {import("express").Response} res
 * @param {unknown} chunk
 */
function writeChunk(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * @param {{
 *   res: import("express").Response,
 *   baseUrl: string,
 *   apiKey: string,
 *   modelId: string,
 *   body: unknown,
 *   signal: AbortSignal,
 *   extraHeaders?: Record<string, string>,
 *   dispatcher?: import("undici").Dispatcher,
 * }} opts
 */
export async function proxyAdaptedGoStream(opts) {
  const built = buildGoRequest(opts.modelId, opts.body);
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
    ...built.headers,
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  const upstream = await undiciFetch(`${opts.baseUrl}${built.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(built.body),
    signal: opts.signal,
    dispatcher: opts.dispatcher,
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
  if (!upstream.body || (!contentType.includes("text/event-stream") && !contentType.includes("application/json") && !contentType.includes("text/plain"))) {
    throw fail("Inference endpoint did not return an event stream", 502);
  }
  opts.res.status(200);
  opts.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  opts.res.setHeader("Cache-Control", "no-store");
  opts.res.setHeader("X-Accel-Buffering", "no");
  if (typeof opts.res.flushHeaders === "function") opts.res.flushHeaders();
  const translator = createGoTranslator(built.protocol);
  const reader = createSseReader();
  const web = upstream.body.getReader();
  const decode = new TextDecoder();
  let stopped = false;
  /**
   * @param {{ event: string, data: string }} ev
   */
  const apply = (ev) => {
    if (stopped || ev.data === "[DONE]") {
      stopped = true;
      return;
    }
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      writeChunk(opts.res, { error: { message: "Malformed inference stream event" } });
      stopped = true;
      return;
    }
    for (const chunk of translator.push(redactKey(data, opts.apiKey))) writeChunk(opts.res, chunk);
  };
  try {
    for (;;) {
      const { value, done } = await web.read();
      if (done || stopped) break;
      for (const ev of reader.feed(decode.decode(value, { stream: true }))) {
        apply(ev);
        if (stopped) break;
      }
    }
    if (!stopped && !opts.res.writableEnded) {
      for (const ev of reader.feed(decode.decode())) apply(ev);
      for (const ev of reader.finish()) apply(ev);
      for (const chunk of translator.end()) writeChunk(opts.res, chunk);
      opts.res.write("data: [DONE]\n\n");
    }
  } catch (err) {
    if (!opts.signal?.aborted && opts.res.headersSent && !opts.res.writableEnded) {
      writeChunk(opts.res, { error: { message: "OpenCode Go stream failed" } });
    } else if (!opts.res.headersSent) {
      throw err;
    }
  } finally {
    await web.cancel().catch(() => undefined);
    web.releaseLock();
    if (!opts.res.writableEnded) opts.res.end();
  }
}

/**
 * @param {unknown} value
 * @param {string | null | undefined} apiKey
 */
function redactKey(value, apiKey) {
  if (!apiKey) return value;
  const walk = (item) => {
    if (typeof item === "string") return item.split(apiKey).join("[redacted]");
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, child] of Object.entries(item)) out[key] = walk(child);
      return out;
    }
    return item;
  };
  return walk(value);
}
