import {MAX_OUTPUT_TOKENS, type Message, type Setup} from './types';
import {thinkingEnabled, type GenerationDefaults} from './generation-defaults';
export function buildRequest(setup: Setup, messages: Message[], metadata: GenerationDefaults | null = null, engine: string | null = metadata?.engine ?? null) {
  if (messages.some(m => m.interrupted)) throw new Error('Discard the interrupted reply before continuing');
  const result: Record<string, unknown> = {
    messages: [...(setup.system ? [{role: 'system', content: setup.system}] : []), ...messages.map(m => ({
      role: m.role, content: m.content,
      ...(m.tool_calls?.length ? {tool_calls: m.tool_calls} : {}),
      ...(m.tool_call_id ? {tool_call_id: m.tool_call_id} : {})
    }))],
    max_tokens: Number(setup.max_tokens)
  };
  if (!Number.isInteger(result.max_tokens) || Number(result.max_tokens) < 1 || Number(result.max_tokens) > MAX_OUTPUT_TOKENS) throw new Error('Max tokens must be an integer from 1 to 262144');
  for (const [key, min, max] of [['temperature', 0, 2], ['top_p', 0, 1]] as const) {
    if (setup[key].trim()) {
      const value = Number(setup[key]);
      if (!Number.isFinite(value) || value < min || value > max || key === 'top_p' && value === 0) throw new Error(`Invalid ${key}`);
      result[key] = value;
    }
  }
  if (setup.top_k?.trim()) {
    const value = Number(setup.top_k);
    if (!Number.isInteger(value) || value < 0) throw new Error('Top K must be a non-negative integer');
    result.top_k = value;
  }
  if (setup.presence_penalty?.trim()) {
    const value = Number(setup.presence_penalty);
    if (!Number.isFinite(value) || value < -2 || value > 2) throw new Error('Presence penalty must be between -2 and 2');
    if (engine !== 'tensorfold') result.presence_penalty = value;
  }
  if (setup.thinking_budget?.trim()) {
    const value = Number(setup.thinking_budget);
    if (!Number.isInteger(value) || value < 0 || value > MAX_OUTPUT_TOKENS) throw new Error('Thinking budget must be an integer from 0 to 262144');
    if (setup.thinking !== 'off' && (engine === null || engine === 'vllm' || engine === 'tensorfold')) {
      if (engine === 'tensorfold' && value === 0) throw new Error('TensorFold thinking budget must be at least 1; disable Thinking to skip reasoning');
      result[engine === 'vllm' ? 'thinking_token_budget' : 'thinking_budget'] = value;
    }
  }
  const kwargs: Record<string, unknown> = {};
  if (setup.thinking !== 'default') kwargs.enable_thinking = setup.thinking === 'on';
  if (setup.reasoning_effort && (setup.request_effort || thinkingEnabled(setup.thinking, metadata))) {
    if (!['low', 'medium', 'high', 'xhigh'].includes(setup.reasoning_effort)) throw new Error('Unsupported reasoning effort');
    if (setup.request_effort === 'request') result.reasoning_effort = setup.reasoning_effort;
    else kwargs.reasoning_effort = setup.reasoning_effort;
  }
  if (Object.keys(kwargs).length) result.chat_template_kwargs = kwargs;
  if (setup.tools.trim()) {
    const tools = JSON.parse(setup.tools);
    if (!Array.isArray(tools) || tools.some(t => t.type !== 'function' || typeof t.function?.name !== 'string')) throw new Error('Tools must be an array of named function definitions');
    if (tools.length) {result.tools = tools; result.tool_choice = 'auto';}
  }
  return result;
}
