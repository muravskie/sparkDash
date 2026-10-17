import {html} from 'lit';
import {formatUsd} from '../providerCost';
import type {ChatChunk, TurnState} from './stream';
import type {ChatUsage, Message, TurnStats} from './types';

export const TOKEN_STALL_SECONDS = 60;
export function hasStreamOutput(raw: unknown): boolean {
  const delta = (raw as ChatChunk)?.choices?.[0]?.delta;
  return !!(delta?.content || delta?.reasoning || delta?.reasoning_content || delta?.tool_calls?.some(t => t.function?.name || t.function?.arguments));
}

export function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function tokens(value: unknown): number | null {
  const number = nonnegative(value); return number != null && Number.isInteger(number) ? number : null;
}
export function splitTokenCounts(usage: ChatUsage | undefined, reasoning: string, reportedReasoning?: unknown) {
  const completion = tokens(usage?.completion_tokens);
  let thinking = tokens(usage?.completion_tokens_details?.reasoning_tokens) ?? tokens(usage?.reasoning_tokens) ?? tokens(reportedReasoning);
  if (thinking != null && (completion != null && thinking > completion || thinking === 0 && reasoning.trim().length > 0)) thinking = null;
  return {thinking, answer: completion != null && thinking != null ? completion - thinking : null};
}

export interface LiveTurnStats {
  elapsed_ms: number; ttft_ms: number | null; generated_tokens: number | null; estimated: boolean;
}

class LiveTokenCounter {
  private fields = new Map<string, {length: number; bytes: number}>();
  private encoder = new TextEncoder();
  count(state: TurnState): {value: number; estimated: boolean} {
    const reported = tokens(state.usage?.completion_tokens);
    if (reported != null) return {value: reported, estimated: false};
    // Count only newly displayed text, avoiding a full retokenization or scan on
    // every frame. The reducer has already removed duplicate thinking fields.
    const fields: [string, string][] = [['answer', state.content], ['thinking', state.reasoning]];
    state.toolCalls.forEach((call, index) => {
      fields.push([`tool-${index}-name`, call.function.name], [`tool-${index}-args`, call.function.arguments]);
    });
    let bytes = 0;
    for (const [key, value] of fields) {
      const previous = this.fields.get(key);
      const length = previous && value.length >= previous.length ? previous.length : 0;
      const count = (length ? previous!.bytes : 0) + this.encoder.encode(value.slice(length)).length;
      this.fields.set(key, {length: value.length, bytes: count}); bytes += count;
    }
    return {value: Math.ceil(bytes / 4), estimated: bytes > 0};
  }
}

export class TurnClock {
  private first: number | null = null;
  private last: number | null = null;
  private liveTokens = new LiveTokenCounter();
  constructor(private started: number) {}
  observe(raw: unknown, arrival: number) {
    if (!Number.isFinite(arrival) || arrival < this.started) return;
    const choice = (raw as ChatChunk)?.choices?.[0];
    const output = hasStreamOutput(raw);
    if (output) {this.first ??= arrival; this.last = arrival;}
    if (choice?.finish_reason && this.first != null) this.last = arrival;
  }
  live(state: TurnState, now: number): LiveTurnStats {
    const generated = this.liveTokens.count(state);
    return {elapsed_ms: nonnegative(now - this.started) ?? 0,
      ttft_ms: this.first == null ? null : nonnegative(this.first - this.started),
      generated_tokens: generated.value, estimated: generated.estimated};
  }
  finish(state: TurnState, ended: number, interrupted = false): TurnStats {
    const usage = state.usage, timing = state.timings, metrics = state.metrics, tensorfold = state.tensorfold;
    const elapsed = nonnegative(ended - this.started);
    const browserTtft = this.first == null ? null : nonnegative(this.first - this.started);
    const nativeTtft = nonnegative(tensorfold?.time_to_first_token);
    const engineTtft = nonnegative(timing?.ttft_ms) ?? nonnegative(metrics?.time_to_first_token_ms)
      ?? (nativeTtft == null ? null : nativeTtft * 1000);
    const prompt = tokens(usage?.prompt_tokens), completion = tokens(usage?.completion_tokens);
    // A reported zero is inconsistent with visible reasoning, rather than a
    // reliable split of thinking and answer tokens.
    const {thinking, answer} = splitTokenCounts(usage, state.reasoning, timing?.reasoning_n);
    let prefill = nonnegative(timing?.prompt_per_second);
    const nativePrefill = nonnegative(tensorfold?.prefill_seconds);
    if (prefill == null && prompt != null && nativePrefill != null && nativePrefill > 0) prefill = prompt / nativePrefill;
    let prefillSource: TurnStats['prefill_source'] = prefill == null ? null : 'engine';
    if (prefill == null && prompt != null && browserTtft != null && browserTtft > 0) {
      prefill = prompt * 1000 / browserTtft; prefillSource = 'estimate';
    }
    let generation = interrupted ? null : nonnegative(timing?.predicted_per_second) ?? nonnegative(tensorfold?.tokens_per_second);
    let generationSource: TurnStats['generation_source'] = generation == null ? null : 'engine';
    const engineDecode = nonnegative(metrics?.generation_time_ms);
    const browserDecode = this.first != null && this.last != null ? nonnegative(this.last - this.first) : null;
    if (!interrupted && generation == null && completion != null && completion > 1) {
      const decode = engineDecode != null && engineDecode > 0 ? engineDecode : browserDecode;
      if (decode != null && decode > 0) {
        generation = (completion - 1) * 1000 / decode;
        generationSource = engineDecode != null && engineDecode > 0 ? 'engine' : 'estimate';
      }
    }
    return {elapsed_ms: elapsed, ttft_ms: engineTtft ?? browserTtft,
      thinking_tokens: thinking, answer_tokens: answer,
      prefill_tps: nonnegative(prefill), generation_tps: nonnegative(generation),
      ttft_source: engineTtft != null ? 'engine' : browserTtft != null ? 'browser' : null,
      prefill_source: prefillSource, generation_source: generationSource};
  }
}

function count(value: unknown, estimated = false) {
  const n = tokens(value);
  return n == null ? '—' : `${estimated ? '≈ ' : ''}${n.toLocaleString()}`;
}
function seconds(value: unknown) {const ms = nonnegative(value); return ms == null ? '—' : `${(ms / 1000).toLocaleString(undefined, {maximumFractionDigits: 2})} s`;}
function ttft(value: unknown) {const ms = nonnegative(value); return ms == null ? '—' : ms < 1000 ? `${ms.toLocaleString(undefined, {maximumFractionDigits: 0})} ms` : seconds(ms);}
function rate(value: unknown) {const n = nonnegative(value); return n == null ? '—' : `${n.toLocaleString(undefined, {maximumFractionDigits: n < 1 ? 3 : 1})} tok/s`;}

export function renderLiveStatus(stats: LiveTurnStats | null, running: boolean) {
  const elapsed = Math.floor((stats?.elapsed_ms ?? 0) / 100);
  const stopwatch = `${Math.floor(elapsed / 600)}:${String(Math.floor(elapsed / 10) % 60).padStart(2, '0')}.${elapsed % 10}`;
  return html`<span class="live-generation-stats" aria-label="Generation progress">
    <span role=${running ? 'timer' : 'status'} aria-live="off" title="Elapsed time for this request, including waiting">${stopwatch}</span>
    <span title="Time to first reasoning, answer, or tool output; engine timing is used after completion when available">TTFT ${ttft(stats?.ttft_ms)}</span>
    <span title=${stats?.estimated ? 'Estimated from generated text, including reasoning and tool output. Exact engine usage replaces this estimate when reported.' : 'Generated tokens reported by the engine, including thinking and answer'}>Generated ${stats?.estimated ? '≈ ' : ''}${count(stats ? stats.generated_tokens : 0)}</span>
  </span>`;
}

const TOKEN_LIMITS = new Set(['length', 'max_tokens', 'max_output_tokens']);

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

export function hitTokenLimit(message: Message): boolean {
  if (message.finish && TOKEN_LIMITS.has(message.finish)) return true;
  if (message.usage_estimated) return false;
  const cap = message.output_limit;
  const completion = tokens(message.usage?.completion_tokens);
  return typeof cap === 'number' && cap > 0 && completion != null && completion >= cap;
}

export function stopReason(message: Message): {text: string; warning: boolean; title: string} | null {
  if (hitTokenLimit(message)) {
    const duringThinking = !!(message.reasoning?.trim() && !message.content.trim() && !message.tool_calls?.length);
    return {
      text: duringThinking ? 'Token limit reached during thinking' : 'Token limit reached',
      warning: true,
      title: 'The provider stopped because the reply used the requested output limit.',
    };
  }
  if (message.finish === 'interrupted' || message.interrupted) return {
    text: 'Interrupted', warning: false, title: 'This reply was stopped before the provider finished it.',
  };
  if (message.finish === 'stop') return {
    text: 'End of turn', warning: false, title: 'The provider finished the reply before the output limit.',
  };
  if (message.finish === 'tool_calls' || message.finish === 'function_call') return {
    text: 'Stopped for a tool call', warning: false, title: 'The provider stopped to wait for a tool result.',
  };
  if (message.finish === 'content_filter') return {
    text: 'Stopped by content filter', warning: false, title: 'The provider stopped this reply in its content filter.',
  };
  if (message.finish) return {
    text: `Stopped: ${message.finish}`, warning: false, title: 'Stop reason reported by the provider.',
  };
  if (message.stats || message.usage) return {
    text: 'Stop reason not reported', warning: true, title: 'The stream ended without a completion marker, so the output limit cannot be confirmed.',
  };
  return null;
}

export function completionWarning(message: Message): string | null {
  const reason = stopReason(message);
  return reason?.warning ? reason.text : null;
}

export function renderTurnStatus(message: Message) {
  const usage = message.usage, stats = message.stats;
  const split = splitTokenCounts(usage, message.reasoning || '');
  const estimated = message.usage_estimated === true;
  const reported = estimated
    ? 'Estimated from the request and reply text because the provider did not report token usage.'
    : 'Reported by the provider.';
  const cap = typeof message.output_limit === 'number' && message.output_limit > 0
    ? ` Requested output limit ${message.output_limit.toLocaleString()}.` : '';
  const reason = stopReason(message);
  const items: [string, string][] = [];
  if (reason && !reason.warning) items.push([reason.text, reason.title]);
  items.push(
    [`${count(usage?.prompt_tokens, estimated)} prompt`, reported],
    [`${count(usage?.completion_tokens, estimated)} completion`, `${reported}${cap}`],
    [`${count(usage?.total_tokens, estimated)} total tokens`, reported],
    [`Total ${seconds(stats?.elapsed_ms)}`, 'Browser elapsed time from sending this request until the stream ends, including waiting and network time.'],
    [`TTFT ${ttft(stats?.ttft_ms)}`, stats?.ttft_source === 'engine' ? 'Time to first token reported by the engine.' : 'Browser time to first nonempty reasoning, answer, or function-call output; includes queue, prefill, and network time.'],
    [`${count(stats?.thinking_tokens ?? split.thinking, estimated && (stats?.thinking_tokens ?? split.thinking) != null)} thinking`, estimated ? reported : 'Reasoning tokens reported in provider usage; unavailable when missing or inconsistent.'],
    [`${count(stats?.answer_tokens ?? split.answer, estimated && (stats?.answer_tokens ?? split.answer) != null)} answer`, estimated ? reported : 'Completion tokens minus reported reasoning tokens; includes tool-call and control tokens.'],
    [`Prefill ${stats?.prefill_source === 'estimate' ? '≈ ' : ''}${rate(stats?.prefill_tps)}`, stats?.prefill_source === 'engine' ? 'Prompt processing rate reported by the engine.' : 'Effective prompt throughput estimate: prompt tokens divided by browser TTFT, including queue/network time and cached prompt tokens.'],
    [`Generation ${stats?.generation_source === 'estimate' ? '≈ ' : ''}${rate(stats?.generation_tps)}`, stats?.generation_source === 'engine' ? 'Engine decode rate, or (completion tokens − 1) divided by reported decode time.' : 'Observed generation estimate: (completion tokens − 1) divided by browser time from first output to finish marker. Includes thinking and tool output; network buffering and chunk batching affect this estimate.']
  );
  const cost = typeof message.cost_usd === 'number' ? formatUsd(message.cost_usd) : '';
  if (cost) items.push([cost, 'Cost of this reply from reported tokens and the provider’s published per-1M rates, including cached input when the response reports it.']);
  const warning = completionWarning(message);
  return html`<div class="usage" aria-label="Reply statistics">${warning ? html`<span class="usage-item usage-warning" role="status" title=${reason?.title || ''}>${warning}</span>` : null}${items.map(([text, title]) => html`<span class="usage-item" title=${title}>${text}</span>`)}</div>`;
}
