export interface GenerationDefaults {
  model_id: string; engine: string;
  engine_defaults: Record<string, number>; engine_source: string;
  engine_api_defaults?: Record<string, number>;
  model_defaults: Record<string, number>; model_source: string;
  template_defaults: {enable_thinking?: boolean; reasoning_effort?: string};
  template_overrides: {enable_thinking?: boolean; reasoning_effort?: string};
  template_source: string;
}
export function samplingDefault(data: GenerationDefaults | null, key: string): {value: string; label: string; source: string} {
  const engine = data?.engine_defaults[key], api = data?.engine_api_defaults?.[key];
  const value = engine ?? api;
  const display = value == null ? 'Not reported' : key === 'thinking_budget' && value === -1 ? 'Unlimited' : String(value);
  return {value: display, label: `${engine == null && api != null ? 'API default' : 'Engine default'}: ${display}`,
    source: engine != null ? data!.engine_source : api != null ? 'Live engine API schema' : 'Not reported by the engine'};
}
export function thinkingEnabled(choice: string, data: GenerationDefaults | null): boolean {
  if (choice !== 'default') return choice === 'on';
  return (data?.template_overrides.enable_thinking ?? data?.template_defaults.enable_thinking) === true;
}
export function defaultLabel(data: GenerationDefaults | null, key: 'enable_thinking' | 'reasoning_effort'): string {
  const value = data?.template_overrides[key] ?? data?.template_defaults[key];
  const display = key === 'enable_thinking' ? typeof value === 'boolean' ? value ? 'Enabled' : 'Disabled' : null
    : typeof value === 'string' ? ({low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high'} as Record<string, string>)[value] : null;
  return 'Model default' + (display ? ' · ' + display : ' · Not reported');
}
