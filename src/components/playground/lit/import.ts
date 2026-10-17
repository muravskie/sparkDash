import {buildRequest} from './request';
import {defaults, type Message, type Setup} from './types';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse completely before replacing the current conversation. */
export function importChatRequest(text: string): {setup: Setup; messages: Message[]; model?: string} {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error('Request exceeds 8 MiB');
  let parsed: unknown;
  try {parsed = JSON.parse(text);} catch {throw new Error('Invalid JSON. Check closing brackets and trailing commas.');}
  const body = Array.isArray(parsed) ? {messages: parsed} : parsed;
  if (!object(body)) throw new Error('Paste a chat request object or a messages array.');
  const allowed = ['model', 'messages', 'temperature', 'top_p', 'top_k', 'presence_penalty', 'thinking_budget', 'thinking_token_budget', 'max_tokens', 'reasoning_effort', 'chat_template_kwargs', 'tools', 'tool_choice', 'stream', 'stream_options'];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`Unsupported request field: ${key}`);
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw new Error('model must be a non-empty string');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('stream must be a boolean');
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) throw new Error('Unsupported stream_options');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw new Error('messages must contain 1 to 256 messages');
  const pending = new Set<string>();
  const messages: Message[] = body.messages.map((value: unknown, index: number) => {
    const label = `Message ${index + 1}`;
    if (!object(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role))) throw new Error(`${label}: unsupported role`);
    if (Object.keys(value).some(k => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(k))) throw new Error(`${label}: unsupported field`);
    if (typeof value.content !== 'string' && !(value.content === null && value.role === 'assistant')) throw new Error(`${label}: content must be text`);
    const message: Message = {role: value.role as Message['role'], content: value.content as string || ''};
    if (value.role === 'tool') {
      if (typeof value.tool_call_id !== 'string' || !pending.delete(value.tool_call_id)) throw new Error(`${label}: tool result must match an outstanding call`);
      message.tool_call_id = value.tool_call_id;
    } else if (pending.size) throw new Error(`${label}: submit all outstanding tool results before continuing`);
    if (value.tool_call_id !== undefined && value.role !== 'tool') throw new Error(`${label}: tool_call_id requires the tool role`);
    if (value.tool_calls !== undefined) {
      if (value.role !== 'assistant' || !Array.isArray(value.tool_calls)) throw new Error(`${label}: tool_calls requires an assistant message and an array`);
      message.tool_calls = value.tool_calls.map((call: unknown) => {
        if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || !object(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string' || pending.has(call.id)) throw new Error(`${label}: invalid tool call`);
        pending.add(call.id);
        return {id: call.id, type: 'function', function: {name: call.function.name, arguments: call.function.arguments}};
      });
    }
    return message;
  });
  if (pending.size) throw new Error('Submit all outstanding tool results before importing.');
  const setup = defaults();
  for (const key of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'thinking_budget', 'max_tokens'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'number') throw new Error(`${key} must be a number`);
    setup[key] = String(body[key]);
  }
  if (body.thinking_token_budget !== undefined) {
    if (body.thinking_budget !== undefined) throw new Error('Specify thinking budget in only one place.');
    if (typeof body.thinking_token_budget !== 'number') throw new Error('thinking_token_budget must be a number');
    setup.thinking_budget = String(body.thinking_token_budget);
  }
  if (body.reasoning_effort !== undefined) {
    if (typeof body.reasoning_effort !== 'string') throw new Error('reasoning_effort must be a string');
    setup.reasoning_effort = body.reasoning_effort;
    setup.request_effort = 'request';
  }
  if (body.chat_template_kwargs !== undefined) {
    const kwargs = body.chat_template_kwargs;
    if (!object(kwargs) || Object.keys(kwargs).some(k => !['enable_thinking', 'reasoning_effort'].includes(k))) throw new Error('Unsupported chat_template_kwargs');
    if (kwargs.enable_thinking !== undefined) {
      if (typeof kwargs.enable_thinking !== 'boolean') throw new Error('enable_thinking must be a boolean');
      setup.thinking = kwargs.enable_thinking ? 'on' : 'off';
    }
    if (kwargs.reasoning_effort !== undefined) {
      if (body.reasoning_effort !== undefined) throw new Error('Specify reasoning_effort in only one place.');
      if (typeof kwargs.reasoning_effort !== 'string') throw new Error('reasoning_effort must be a string');
      setup.reasoning_effort = kwargs.reasoning_effort;
      setup.request_effort = 'template';
    }
  }
  if (body.tools !== undefined) setup.tools = JSON.stringify(body.tools);
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto') throw new Error('Only auto tool_choice is supported by this playground.');
  if (body.tool_choice !== undefined && !Array.isArray(body.tools)) throw new Error('tool_choice requires tools');
  buildRequest(setup, messages); // validate settings before returning any state
  return {setup, messages, ...(typeof body.model === 'string' ? {model: body.model} : {})};
}
