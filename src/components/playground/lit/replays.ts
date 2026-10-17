export const REPLAY_HISTORY_KEY = 'llm-dashboard-replays-v1';
export const MAX_REPLAY_RUNS = 100;
export const MAX_REPLAY_BYTES = 1_000_000;

export interface ReplayRun {
  id: string;
  modelId: string;
  conversationId: string;
  /** Index of the original user message, for matching its saved reply. */
  messageIndex?: number;
  at: number;
  user: string;
  system: string;
  temperature: string;
  top_p: string;
  max_tokens: number;
  thinkingEnabled: boolean | null;
  effortLabel: string;
  request: Record<string, unknown>;
  status: 'ready' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  source?: 'conversation-history';
  lastReplayAt?: number;
  result?: string;
  durationMs?: number;
  generatedTokens?: number | null;
  estimatedTokens?: boolean;
  generationTps?: number | null;
  estimatedGenerationTps?: boolean;
  totalTokens?: number | null;
  estimatedTotalTokens?: boolean;
}

function validRun(value: unknown): value is ReplayRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as ReplayRun;
  const messages = run.request && Array.isArray(run.request.messages) ? run.request.messages as {role?: string; content?: unknown}[] : [];
  return typeof run.id === 'string' && typeof run.modelId === 'string' && typeof run.conversationId === 'string' &&
    Number.isFinite(run.at) && typeof run.user === 'string' && typeof run.system === 'string' &&
    typeof run.temperature === 'string' && typeof run.top_p === 'string' && Number.isInteger(run.max_tokens) &&
    (typeof run.thinkingEnabled === 'boolean' || run.thinkingEnabled === null) && typeof run.effortLabel === 'string' &&
    messages.some(message => message.role === 'user' && message.content === run.user) &&
    messages.every(message => message.role !== 'system' || message.content === run.system) &&
    ['ready', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(run.status);
}

export function parseReplayRuns(raw: string | null): ReplayRun[] {
  if (!raw) return [];
  if (new TextEncoder().encode(raw).length > MAX_REPLAY_BYTES) throw new Error('Saved replay history exceeds its size limit');
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error('Invalid replay history');
  return values.filter(validRun).sort((a, b) => a.at - b.at).slice(-MAX_REPLAY_RUNS).map(run =>
    run.status === 'queued' || run.status === 'running'
      ? {...run, status: 'cancelled', result: 'Browser closed before replay finished'}
      : run);
}

export function boundedReplayRuns(values: ReplayRun[]): ReplayRun[] {
  let runs = [...values].sort((a, b) => a.at - b.at).slice(-MAX_REPLAY_RUNS);
  while (runs.length && new TextEncoder().encode(JSON.stringify(runs)).length > MAX_REPLAY_BYTES) runs = runs.slice(1);
  return runs;
}

export function replayConcurrencyLimit(modelId: string, engine: string | null | undefined): number {
  if (modelId === 'qwen3.8-flash-next-tensorfold' || engine === 'tensorfold') return 8;
  if (modelId === 'qwen3.8-flash-next' && engine === 'vllm') return 16;
  return 1;
}
