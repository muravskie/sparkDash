export interface ToolCall {id: string; type: 'function'; function: {name: string; arguments: string}}
export interface ChatUsage {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; reasoning_tokens?: number | null; completion_tokens_details?: {reasoning_tokens?: number | null} | null; [key: string]: unknown}
export type ChatTimings = Record<string, unknown>;
export type ChatMetrics = Record<string, unknown>;
export interface TurnStats {
  elapsed_ms: number | null; ttft_ms: number | null;
  thinking_tokens: number | null; answer_tokens: number | null;
  prefill_tps: number | null; generation_tps: number | null;
  ttft_source: 'engine' | 'browser' | null;
  prefill_source: 'engine' | 'estimate' | null;
  generation_source: 'engine' | 'estimate' | null;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoning?: string;
  tool_calls?: ToolCall[]; tool_call_id?: string;
  usage?: ChatUsage; finish?: string | null; interrupted?: boolean;
  /** True when prompt and completion counts were estimated from the text. */
  usage_estimated?: boolean;
  /** max_tokens sent for this reply. */
  output_limit?: number;
  /** Dollars for a paid provider reply, from reported tokens and catalog rates. */
  cost_usd?: number | null;
  stats?: TurnStats;
}
export interface Setup {system: string; temperature: string; top_p: string; top_k?: string; presence_penalty?: string; thinking_budget?: string; max_tokens: string; thinking: string; reasoning_effort: string; request_effort?: 'request' | 'template'; tools: string}
export const defaults = (): Setup => ({system: '', temperature: '', top_p: '', top_k: '', presence_penalty: '', thinking_budget: '', max_tokens: '2048', thinking: 'default', reasoning_effort: '', tools: ''});

export const MAX_OUTPUT_TOKENS = 262144;
export const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
export const MAX_TOKEN_CHOICES = Array.from({length: 19}, (_, power) => 2 ** power);
export function normalizeSetup(setup: Setup): Setup {
  const value = Number(setup.max_tokens);
  const max = Number.isInteger(value) && value >= 1 && value <= MAX_OUTPUT_TOKENS ? value : Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(MAX_OUTPUT_TOKENS, 2 ** Math.ceil(Math.log2(value)))) : 2048;
  return {...setup, max_tokens: String(max)};
}
