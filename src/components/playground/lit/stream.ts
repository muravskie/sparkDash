// Replaces vendor/tandem/playground/stream.ts. The playground still feeds it
// OpenAI chat chunks and reads one growing turn back. This file is local.
import type { ChatMetrics, ChatTimings, ChatUsage, ToolCall } from "./types";
import { SseParser } from "./sse";

export interface ChatChunk {
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage;
  timings?: ChatTimings;
  metrics?: ChatMetrics;
  tensorfold?: Record<string, unknown>;
  error?: { message: string; type?: string };
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface TurnState {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string | null;
  usage?: ChatUsage;
  timings?: ChatTimings;
  metrics?: ChatMetrics;
  tensorfold?: Record<string, unknown>;
  error?: { message: string; type?: string } | null;
  chunks: number;
  answerStarted: boolean;
  inThink: boolean;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function asCount(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/** Accept the OpenAI usage object and the input/output names some providers send. */
export function normalizeUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = asCount(usage.prompt_tokens ?? usage.input_tokens);
  const completion = asCount(usage.completion_tokens ?? usage.output_tokens);
  const total = asCount(usage.total_tokens) ?? (prompt != null && completion != null ? prompt + completion : undefined);
  if (prompt == null && completion == null && total == null) return undefined;
  const details = usage.completion_tokens_details;
  const reasoning = asCount(
    (details && typeof details === "object" ? (details as { reasoning_tokens?: unknown }).reasoning_tokens : undefined)
      ?? usage.reasoning_tokens
  );
  const normalized: ChatUsage = { ...(usage as ChatUsage) };
  if (prompt != null) normalized.prompt_tokens = prompt;
  if (completion != null) normalized.completion_tokens = completion;
  if (total != null) normalized.total_tokens = total;
  if (reasoning != null) {
    const details = usage.completion_tokens_details;
    normalized.completion_tokens_details = {
      ...(details && typeof details === "object" ? details as ChatUsage["completion_tokens_details"] : {}),
      reasoning_tokens: reasoning,
    };
  }
  const cached = asCount(
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as { cached_tokens?: unknown }).cached_tokens
      : undefined
  );
  if (cached != null) {
    normalized.prompt_tokens_details = {
      ...(usage.prompt_tokens_details as object),
      cached_tokens: cached,
    };
  }
  return normalized;
}

/** Trailing characters of `text` that are a prefix of `tag` and might still complete. */
function heldSuffix(text: string, tag: string): number {
  const limit = Math.min(text.length, tag.length - 1);
  for (let size = limit; size > 0; size--) {
    if (tag.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

/**
 * Read `data:` SSE events from an OpenAI chat stream. Abort cancels the reader
 * so a stopped generation does not wait on a hung body.
 */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; onBytes?: (n: number) => void; onArrival?: (at: number) => void } = {}
): AsyncGenerator<unknown> {
  const parser = new SseParser();
  const reader = body.getReader();
  const decode = new TextDecoder();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (opts.signal?.aborted) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    return;
  }
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const yieldEvents = function* (events: { data: string }[]): Generator<unknown, boolean> {
      for (const event of events) {
        if (event.data === "[DONE]") return true;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          throw new Error("Malformed inference stream event");
        }
        yield parsed;
      }
      return false;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done || opts.signal?.aborted) {
        if (!opts.signal?.aborted) {
          yield* yieldEvents([...parser.feed(decode.decode()), ...parser.finish()]);
        }
        return;
      }
      opts.onArrival?.(performance.now());
      if (value) opts.onBytes?.(value.byteLength);
      const stopped = yield* yieldEvents(parser.feed(decode.decode(value, { stream: true })));
      if (stopped) return;
    }
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** OpenAI chunks in, one turn out. `<think>` in content is split into reasoning. */
export class ChatStreamReducer {
  readonly state: TurnState = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finish: null,
    error: null,
    chunks: 0,
    answerStarted: false,
    inThink: false,
  };
  private pending = "";
  private tagged = "";
  private field = "";
  private calls = new Map<number, ToolCall>();

  feed(raw: unknown): void {
    const chunk = raw as ChatChunk;
    this.state.chunks++;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const reasoning = delta?.reasoning_content || delta?.reasoning;
    if (reasoning) {
      this.field += reasoning;
      this.state.reasoning = this.field;
    }
    if (delta?.content) {
      this.pending += delta.content;
      this.drain(false);
    }
    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) this.toolDelta(call);
    }
    const finish = choice?.finish_reason || (chunk as { finish_reason?: string }).finish_reason;
    if (finish) this.state.finish = finish;
    const usage = normalizeUsage(chunk.usage);
    if (usage) this.state.usage = usage;
    if (chunk.timings) this.state.timings = { ...this.state.timings, ...chunk.timings };
    if (chunk.metrics) this.state.metrics = { ...this.state.metrics, ...chunk.metrics };
    if (chunk.tensorfold) this.state.tensorfold = { ...this.state.tensorfold, ...chunk.tensorfold };
    if (chunk.error) this.state.error = chunk.error;
  }

  end(): TurnState {
    this.drain(true);
    return this.state;
  }

  private toolDelta(delta: ToolCallDelta): void {
    const index = typeof delta.index === "number" ? delta.index : this.calls.size;
    let call = this.calls.get(index);
    if (!call) {
      call = {
        id: delta.id ?? "",
        type: "function",
        function: { name: delta.function?.name ?? "", arguments: "" },
      };
      this.calls.set(index, call);
    } else {
      if (delta.id) call.id += delta.id;
      if (delta.function?.name) call.function.name += delta.function.name;
    }
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
    this.state.toolCalls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.state.inThink) {
        const closeAt = this.pending.indexOf(THINK_CLOSE);
        if (closeAt < 0) {
          const hold = final ? 0 : heldSuffix(this.pending, THINK_CLOSE);
          this.tagged += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
          break;
        }
        this.tagged += this.pending.slice(0, closeAt);
        this.pending = this.pending.slice(closeAt + THINK_CLOSE.length).replace(/^\n{1,2}/, "");
        this.state.inThink = false;
      } else {
        const openAt = this.pending.indexOf(THINK_OPEN);
        if (openAt < 0) {
          const hold = final ? 0 : heldSuffix(this.pending, THINK_OPEN);
          this.emit(this.pending.slice(0, this.pending.length - hold));
          this.pending = this.pending.slice(this.pending.length - hold);
          break;
        }
        this.emit(this.pending.slice(0, openAt));
        this.pending = this.pending.slice(openAt + THINK_OPEN.length).replace(/^\n/, "");
        this.state.inThink = true;
      }
    }
    this.state.reasoning = this.field.length ? this.field : this.tagged;
  }

  private emit(text: string): void {
    if (!text) return;
    this.state.content += text;
    if (this.state.content.trim()) this.state.answerStarted = true;
  }
}
