import {defaults, type Message, type Setup} from './types';

export const HISTORY_KEY = 'llm-dashboard-conversations-v1';
export const MAX_CONVERSATIONS = 30;
export const MAX_HISTORY_BYTES = 2_000_000;
export interface Conversation {id: string; modelId: string; title: string; createdAt: number; updatedAt: number; messages: Message[]; setup: Setup}
export function newConversation(modelId: string, setup: Setup): Conversation {
  const now = Date.now();
  return {id: `${now.toString(36)}-${Math.random().toString(36).slice(2)}`, modelId, title: 'New conversation', createdAt: now, updatedAt: now, messages: [], setup: {...setup}};
}
export function parseConversations(raw: string | null): Conversation[] {
  if (!raw) return [];
  if (new TextEncoder().encode(raw).length > MAX_HISTORY_BYTES) throw new Error('Saved conversation history exceeds its limit');
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Invalid conversation history');
  return records.slice(0, MAX_CONVERSATIONS).filter(c =>
    typeof c?.id === 'string' && typeof c?.modelId === 'string' && typeof c?.title === 'string' && Number.isFinite(c?.createdAt) && Number.isFinite(c?.updatedAt) &&
    Array.isArray(c.messages) && c.messages.every((m: Message) => ['system', 'user', 'assistant', 'tool'].includes(m?.role) && typeof m.content === 'string' && (m.reasoning == null || typeof m.reasoning === 'string') &&
      (m.tool_calls == null || Array.isArray(m.tool_calls) && m.tool_calls.every(t => typeof t?.id === 'string' && t.type === 'function' && typeof t.function?.name === 'string' && typeof t.function?.arguments === 'string'))) &&
    c.setup && ['system', 'temperature', 'top_p', 'max_tokens', 'thinking', 'tools'].every(key => typeof c.setup[key] === 'string') &&
    ['reasoning_effort', 'presence_penalty', 'thinking_budget'].every(key => c.setup[key] == null || typeof c.setup[key] === 'string')
  ).map(c => ({...c, setup: {...defaults(), ...c.setup}}));
}
export function boundedConversations(records: Conversation[], activeId: string): Conversation[] {
  const nonempty = records.filter(c => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
  const active = nonempty.find(c => c.id === activeId);
  const kept = nonempty.slice(0, MAX_CONVERSATIONS);
  if (active && !kept.includes(active)) kept.splice(kept.length - 1, 1, active);
  while (new TextEncoder().encode(JSON.stringify(kept)).length > MAX_HISTORY_BYTES) {
    if (kept.length <= 1) throw new Error('This conversation is too large to save; export it as JSON');
    let oldestOther = kept.length - 1;
    if (kept[oldestOther].id === activeId) oldestOther--;
    kept.splice(oldestOther, 1);
  }
  return kept;
}

export function conversationTimestamp(at: number): string {
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) + ' ' +
    date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
}
