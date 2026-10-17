import {html, nothing, svg, type PropertyValues} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {LightElement} from './base';
import {ChatStreamReducer, readChatStream, type TurnState} from './stream';
import type {Model} from './model';
import {defaults, MAX_TOKEN_CHOICES, MAX_OUTPUT_TOKENS, MAX_RESPONSE_CHARS, normalizeSetup, type Message, type Setup, type ToolCall} from './types';
import {buildRequest} from './request';
import {importChatRequest} from './import';
import {conversationTimestamp, HISTORY_KEY, boundedConversations, newConversation, parseConversations, type Conversation} from './conversations';
import {REPLAY_HISTORY_KEY, boundedReplayRuns, parseReplayRuns, replayConcurrencyLimit, type ReplayRun} from './replays';
import {turnCostUsd} from '../providerCost';
import {TurnClock, renderTurnStatus, renderLiveStatus, estimateTokenCount, type LiveTurnStats, hasStreamOutput, TOKEN_STALL_SECONDS} from './stats';
import {apiFetch, apiJson} from './api';
import {defaultLabel, samplingDefault, thinkingEnabled, type GenerationDefaults} from './generation-defaults';
import './answer-view';
import type {AnswerView} from './answer-view';
import {readProbeRing, recordProbeRing, type EngineProbe, type ProbeRow} from './metricsStrip';
import './metricsStrip';

function waitUntil(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Replay cancelled', 'AbortError'));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {signal.removeEventListener('abort', cancel); resolve();};
    const timer = setTimeout(finish, delayMs);
    const cancel = () => {clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Replay cancelled', 'AbortError'));};
    signal.addEventListener('abort', cancel, {once: true});
  });
}

interface ReplayProgress {
  durationMs: number;
  generatedTokens: number | null;
  estimatedTokens: boolean;
  generationTps: number | null;
  totalTokens: number | null;
  estimatedTotalTokens: boolean;
}

function replayTotalTokens(usage: TurnState['usage'], generatedTokens: number | null, estimatedGenerated: boolean) {
  const total = usage?.total_tokens, prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
  if (Number.isInteger(total) && total! >= 0) return {totalTokens: total as number, estimatedTotalTokens: false};
  if (Number.isInteger(prompt) && prompt! >= 0 && Number.isInteger(completion) && completion! >= 0)
    return {totalTokens: (prompt as number) + (completion as number), estimatedTotalTokens: false};
  if (Number.isInteger(prompt) && prompt! >= 0 && Number.isInteger(generatedTokens) && generatedTokens != null)
    return {totalTokens: (prompt as number) + generatedTokens, estimatedTotalTokens: estimatedGenerated};
  return {totalTokens: null, estimatedTotalTokens: false};
}

function replayElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function replayThinkingSnapshot(setup: Setup, metadata: GenerationDefaults | null, request: Record<string, unknown>) {
  const configured = metadata?.template_overrides.enable_thinking ?? metadata?.template_defaults.enable_thinking;
  const enabled = setup.thinking === 'off' ? false : setup.thinking === 'on' ? true
    : typeof configured === 'boolean' ? configured : null;
  const kwargs = request.chat_template_kwargs as Record<string, unknown> | undefined;
  const effort = kwargs?.reasoning_effort;
  const defaultEffort = metadata?.template_overrides.reasoning_effort || metadata?.template_defaults.reasoning_effort;
  const effortLabel = enabled === false ? 'None' : typeof effort === 'string'
    ? effort === 'xhigh' ? 'Extra high' : effort
    : typeof defaultEffort === 'string' ? `Default (${defaultEffort === 'xhigh' ? 'Extra high' : defaultEffort})` : 'Default';
  return {enabled, effortLabel};
}

@customElement('spark-playground')
export class Playground extends LightElement {
  @property({attribute: false}) declare model?: Model;
  @property({type: Boolean}) declare stale: boolean;
  /** Spark the bench picker selected. Chat and defaults go through its relay. */
  @property() declare sparkId: string;
  @property({type: Number}) declare llmPort: number;
  @property() declare remoteHost: string;
  @property({type: Boolean}) declare remoteTls: boolean;
  /** Hosted provider chat. Skips the local engine probe and defaults. */
  @property({type: Boolean}) declare external: boolean;
  /** Live LLM probe for this Spark and port. Null fields are gaps, not zeros. */
  @property({attribute: false}) declare probe: EngineProbe | null;
  @state() private declare windowSeconds: number;
  @state() private declare sampledAt: number;
  @state() private declare probeRows: ProbeRow[];
  @state() private declare messages: Message[];
  @state() private declare setup: Setup;
  @state() private declare draft: string;
  @state() private declare importOpen: boolean;
  @state() private declare importText: string;
  @state() private declare importError: string;
  @state() private declare busy: boolean;
  @state() private declare error: string;
  @state() private declare notice: string;
  @state() private declare toolResults: Record<string, string>;
  @state() private declare presets: {name: string; setup: Setup}[];
  @state() private declare presetName: string;
  @state() private declare lastRequest: Record<string, unknown> | null;
  @state() private declare conversations: Conversation[];
  @state() private declare activeId: string;
  @state() private declare copied: Message | null;
  @state() private declare sourceView: boolean;
  @state() private declare conversationCollapsed: boolean;
  @state() private declare previewCounts: Record<string, number>;
  @state() private declare previewSelection: string;
  @state() private declare generationDefaults: GenerationDefaults | null;
  @state() private declare defaultsError: string;
  @state() private declare tokenWaitSeconds: number;
  @state() private declare liveStats: LiveTurnStats | null;
  /** Wall-clock start of the current or last reply's first content token. */
  @state() private declare generationFirstAt: number | null;
  /** Wall-clock end of that reply. Null while it is still streaming. */
  @state() private declare generationEndAt: number | null;
  @state() private declare replayRuns: ReplayRun[];
  @state() private declare selectedRunIds: string[];
  @state() private declare replayBusy: boolean;
  @state() private declare replayNow: number;
  @state() private declare replayConcurrency: number;
  @state() private declare replayPacing: 'simultaneous' | 'staggered';
  @state() private declare replaySpreadSeconds: string;
  @state() private declare replayNotice: string;
  private liveClock: TurnClock | null = null;
  /** True until the first content token of this chat or replay batch opens a new generation span. */
  private openGenerationSpan = false;
  /** Wall clock when the current replay batch was requested. The span starts here, before the first browser token. */
  private replaySpanStart = 0;
  private liveState: TurnState | null = null;
  private lastOutputAt = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private defaultsRequest: AbortController | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private currentByModel = new Map<string, string>();
  private controller: AbortController | null = null;
  private replayBatchController: AbortController | null = null;
  private replayControllers = new Set<AbortController>();
  private replayProgress = new Map<string, ReplayProgress>();
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private follow = true;

  constructor() {
    super();
    this.stale = false;
    this.sparkId = '';
    this.llmPort = 0;
    this.remoteHost = '';
    this.remoteTls = false;
    this.external = false;
    this.probe = null;
    this.windowSeconds = 300;
    this.sampledAt = 0;
    this.probeRows = [];
    this.messages = [];
    this.setup = defaults();
    this.draft = '';
    this.importOpen = false;
    this.importText = '';
    this.importError = '';
    this.busy = false;
    this.error = '';
    this.notice = '';
    this.toolResults = {};
    this.presets = [];
    this.presetName = '';
    this.lastRequest = null;
    this.conversations = [];
    this.activeId = '';
    this.copied = null;
    this.sourceView = false;
    this.conversationCollapsed = false;
    this.previewCounts = {};
    this.previewSelection = '';
    this.generationDefaults = null;
    this.defaultsError = '';
    this.tokenWaitSeconds = 0;
    this.liveStats = null;
    this.generationFirstAt = null;
    this.generationEndAt = null;
    this.replayRuns = [];
    this.selectedRunIds = [];
    this.replayBusy = false;
    this.replayNow = Date.now();
    this.replayConcurrency = 0;
    this.replayPacing = 'simultaneous';
    this.replaySpreadSeconds = '2';
    this.replayNotice = '';
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('messages') && !this.conversationCollapsed) {
      const box = this.querySelector('.chat-messages');
      this.follow = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    }
    if (changed.has('probe') || changed.has('sparkId') || changed.has('llmPort') || changed.has('remoteHost') || changed.has('external') || changed.has('model')) this.syncProbe();
  }
  private ringKey() {return this.external ? `provider:${this.model?.id || 'external'}` : this.sparkId + ':' + this.llmPort;}
  private lastExternalSampleAt = 0;
  private syncProbe() {
    if (this.external) {
      this.probeRows = readProbeRing(this.ringKey());
      this.sampledAt = this.probeRows.at(-1)?.at ?? 0;
      return;
    }
    if (this.remoteHost || !this.sparkId) {
      this.probeRows = [];
      this.sampledAt = 0;
      return;
    }
    if (!this.probe) {
      this.probeRows = readProbeRing(this.ringKey());
      this.sampledAt = this.probeRows.at(-1)?.at ?? 0;
      return;
    }
    this.probeRows = recordProbeRing(this.ringKey(), this.probe, Date.now(), this.probe);
    this.sampledAt = this.probeRows.at(-1)?.at ?? 0;
  }
  private pickWindow(event: Event) {
    const seconds = Number((event as CustomEvent<number>).detail);
    if (seconds === 60 || seconds === 300 || seconds === 900 || seconds === 1800) this.windowSeconds = seconds;
  }

  connectedCallback() {
    super.connectedCallback();
    try {
      const presets = JSON.parse(localStorage.getItem('llm-dashboard-presets-v1') || '[]');
      if (Array.isArray(presets)) this.presets = presets.filter(p => typeof p.name === 'string' && ['system', 'temperature', 'top_p', 'max_tokens', 'thinking', 'tools'].every(k => typeof p.setup?.[k] === 'string')).map(p => ({...p, setup: normalizeSetup({...defaults(), ...p.setup})}));
    } catch { this.notice = 'Saved presets could not be loaded.'; }
    try {this.conversations = parseConversations(localStorage.getItem(HISTORY_KEY));}
    catch {this.notice = 'Saved conversations could not be loaded. New conversations can still be exported.';}
    try {this.replayRuns = parseReplayRuns(localStorage.getItem(REPLAY_HISTORY_KEY)); this.persistReplayRuns();}
    catch {this.replayNotice = 'Saved prompt runs could not be loaded.';}
  }
  disconnectedCallback() {super.disconnectedCallback(); this.stopTokenWatch(); this.controller?.abort(); this.stopReplayBatch(); if (this.replayTimer) clearInterval(this.replayTimer); this.defaultsRequest?.abort(); if (this.copyTimer) clearTimeout(this.copyTimer);}
  protected updated(changed: PropertyValues) {
    if (changed.has('model') && ((changed.get('model') as Model | undefined)?.id !== this.model?.id || (changed.get('model') as Model | undefined)?.healthy !== this.model?.healthy)) void this.loadGenerationDefaults();
    if ((changed.has('messages') || changed.has('conversationCollapsed') && !this.conversationCollapsed) && this.follow) {
      const box = this.querySelector('.chat-messages'); if (box) box.scrollTop = box.scrollHeight;
    }
    if (changed.has('model') && (changed.get('model') as Model | undefined)?.id !== this.model?.id) {
      this.stopReplayBatch(); this.selectedRunIds = []; this.replayConcurrency = 0;
      this.stopTokenWatch();
      this.controller?.abort(); this.controller = null; this.busy = false;
      const modelId = this.model?.id || '';
      const previous = this.currentByModel.get(modelId);
      const conversation = this.conversations.find(c => c.id === previous) || this.conversations.filter(c => c.modelId === modelId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      this.notice = '';
      if (conversation) this.activate(conversation); else this.startConversation();
      this.draft = ''; this.toolResults = {}; this.error = ''; this.lastRequest = null;
    }
  }
  private toggleConversationFromHeader(e: MouseEvent) {
    if ((e.target as Element).closest('button, select, input, textarea, a, label')) return;
    this.conversationCollapsed = !this.conversationCollapsed;
  }
  private async loadGenerationDefaults() {
    this.defaultsRequest?.abort();
    this.generationDefaults = null; this.defaultsError = '';
    const id = this.model?.id; if (!id || !this.sparkId) return;
    if (this.external) {
      this.defaultsError = 'This provider does not report sampling defaults. Blank fields are omitted.';
      return;
    }
    const request = this.defaultsRequest = new AbortController();
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const data = await apiJson(this.defaultsUrl(), {signal: request.signal});
      if (this.defaultsRequest === request && this.model?.id === id && this.isConnected) {
        this.generationDefaults = data;
        this.importSavedPrompts(id, data);
      }
    } catch {
      if (this.defaultsRequest === request && this.isConnected) this.defaultsError = 'Default values unavailable; omitted fields still use the engine settings.';
    } finally {clearTimeout(timeout);}
  }
  private defaultsUrl() {
    const query = new URLSearchParams();
    query.set('port', String(this.llmPort));
    if (this.remoteHost) {
      query.set('host', this.remoteHost);
      if (this.remoteTls) query.set('tls', '1');
    }
    return `/api/sparks/${encodeURIComponent(this.sparkId)}/playground/generation-defaults?${query}`;
  }
  private postChat(payload: Record<string, unknown>, signal: AbortSignal) {
    const routed: Record<string, unknown> = {...payload, port: this.llmPort};
    if (this.external && this.model?.upstreamId && this.model.engine) {
      routed.provider = this.model.engine;
      routed.modelId = this.model.upstreamId;
      if (this.model.engine === 'opencode-go') routed.sessionId = this.activeId;
    } else if (this.remoteHost) {routed.host = this.remoteHost; routed.tls = this.remoteTls;}
    return apiFetch(`/api/sparks/${encodeURIComponent(this.sparkId)}/playground/stream`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(routed), signal
    });
  }
  private samplingPlaceholder(key: string) {
    const value = samplingDefault(this.generationDefaults, key).value;
    return value === 'Not reported' ? 'Engine default' : 'Default ' + value;
  }
  private renderSamplingDefault(key: string) {
    const data = this.generationDefaults;
    const value = samplingDefault(data, key);
    return html`<span class="context-note setting-default" title=${value.source}>${value.label}${value.value === 'Not reported' && data?.model_defaults[key] != null ? html`<br>Model metadata: ${data.model_defaults[key]}` : nothing}</span>`;
  }
  private renderPenaltyAndBudget() {
    const engine = this.model?.engine ?? this.generationDefaults?.engine;
    const presenceSupported = engine === 'vllm' || engine === 'sglang';
    const budgetSupported = engine === 'vllm' || engine === 'tensorfold';
    return html`<div class="parameter-grid">
      <label>Presence penalty<input aria-label="Presence penalty" type="number" min="-2" max="2" step="0.1"
        .value=${this.setup.presence_penalty ?? ''} ?disabled=${!presenceSupported}
        @input=${(e: Event) => this.setupField('presence_penalty', (e.target as HTMLInputElement).value)}
        placeholder=${presenceSupported ? this.samplingPlaceholder('presence_penalty') : 'Unavailable'}>
        ${presenceSupported ? this.renderSamplingDefault('presence_penalty') : nothing}</label>
      <label>Thinking budget<input aria-label="Thinking budget" type="number" min=${engine === 'tensorfold' ? '1' : '0'} max=${MAX_OUTPUT_TOKENS} step="1"
        .value=${this.setup.thinking_budget ?? ''} ?disabled=${!budgetSupported || this.setup.thinking === 'off'}
        @input=${(e: Event) => this.setupField('thinking_budget', (e.target as HTMLInputElement).value)}
        placeholder=${budgetSupported ? this.samplingPlaceholder('thinking_budget') : 'Unavailable'}>
        ${budgetSupported ? this.renderSamplingDefault('thinking_budget') : nothing}</label>
    </div>
    ${!presenceSupported ? html`<p class="context-note">Presence penalty is unavailable for this engine and is omitted from requests.</p>` : nothing}
    <p class="context-note">${!budgetSupported ? 'Thinking budget is unavailable for this engine and is omitted from requests.'
      : this.setup.thinking === 'off' ? 'Enable Thinking to apply a thinking budget.'
      : 'Thinking budget limits reasoning tokens. Max tokens still includes reasoning and the final answer. Blank uses the engine default.'}</p>`;
  }
  private renderDefaultInfo() {
    const data = this.generationDefaults;
    if (!data) return html`<p class="context-note">${this.defaultsError || 'Loading default values…'}</p>`;
    return html`<details class="generation-defaults"><summary>Default values and sources</summary><dl>
      ${(['temperature', 'top_p', 'top_k', 'presence_penalty', 'thinking_budget'] as const).map(key => html`<dt>${{temperature: 'Temperature', top_p: 'Top P', top_k: 'Top K', presence_penalty: 'Presence penalty', thinking_budget: 'Thinking budget'}[key]}</dt><dd>${samplingDefault(data, key).label}<br>Source: ${samplingDefault(data, key).source}${data.model_defaults[key] != null ? html`<br>Model metadata: ${data.model_defaults[key]}` : nothing}</dd>`)}
      <dt>Engine source</dt><dd>${data.engine_source}</dd><dt>Model source</dt><dd>${data.model_source}</dd>
      <dt>Thinking / effort</dt><dd>${data.template_overrides.enable_thinking != null || data.template_overrides.reasoning_effort ? 'Live server template overrides' : data.template_source}</dd>
      <dt>Max tokens</dt><dd>Playground defaults to 2,048; limit ${MAX_OUTPUT_TOKENS.toLocaleString()}, shared by thinking and answer. The context window also includes the prompt.</dd>
    </dl><p class="context-note">Blank Temperature / Top P / Presence penalty / Thinking budget sends no override. Each Model default choice omits its corresponding template override. Model metadata describes the checkpoint; server settings can override it.</p></details>`;
  }
  private setupField(key: keyof Setup, value: string) {
    this.setup = {...this.setup, [key]: value};
    if (key === 'thinking') this.setup = {...this.setup, request_effort: undefined};
  }
  private get visibleReplayRuns() {return this.replayRuns.filter(run => run.modelId === this.model?.id).sort((a, b) => b.at - a.at);}
  private get replayLimit() {return replayConcurrencyLimit(this.model?.id || '', this.generationDefaults?.engine || this.model?.engine);}
  private importSavedPrompts(modelId: string, metadata: GenerationDefaults) {
    // Recover original-run measurements from the saved reply; never replace replay results.
    this.replayRuns = this.replayRuns.map(run => {
      if (run.modelId !== modelId || run.lastReplayAt != null || run.durationMs != null) return run;
      const conversation = this.conversations.find(c => c.id === run.conversationId);
      if (!conversation) return run;
      const matches = conversation.messages.flatMap((m, index) => m.role === 'user' && m.content === run.user ? [index] : []);
      const index = run.messageIndex ?? (matches.length === 1 ? matches[0] : undefined);
      if (index == null || !matches.includes(index)) return run;
      const reply = conversation.messages[index + 1];
      return {...run, messageIndex: index, ...this.savedReplyMetrics(reply)};
    });
    const known = new Set(this.replayRuns.map(run => run.id));
    const imported: ReplayRun[] = [];
    for (const conversation of this.conversations) {
      if (conversation.modelId !== modelId) continue;
      conversation.messages.forEach((message, index) => {
        const id = `history:${conversation.id}:${index}`;
        if (message.role !== 'user' || known.has(id) || this.replayRuns.some(run => run.conversationId === conversation.id && run.messageIndex === index)) return;
        try {
          const setup = normalizeSetup(conversation.setup);
          const request = buildRequest(setup, [{role: 'user', content: message.content}], metadata);
          const snapshot = replayThinkingSnapshot(setup, metadata, request);
          imported.push({id, modelId, conversationId: conversation.id, at: conversation.updatedAt,
            user: message.content, system: setup.system, temperature: setup.temperature.trim(), top_p: setup.top_p.trim(),
            max_tokens: Number(request.max_tokens), thinkingEnabled: snapshot.enabled, effortLabel: snapshot.effortLabel,
            request, status: 'ready', source: 'conversation-history', messageIndex: index,
            ...this.savedReplyMetrics(conversation.messages[index + 1])});
          known.add(id);
        } catch { /* malformed historical settings remain in the conversation and are not replayable */ }
      });
    }
    if (imported.length) {
      this.replayRuns = boundedReplayRuns([...this.replayRuns, ...imported]);
    }
    this.persistReplayRuns();
  }
  private savedReplyMetrics(reply: Message | undefined): Partial<ReplayRun> {
    if (reply?.role !== 'assistant' || (!reply.stats && !reply.usage)) return {};
    const tokens = reply.usage?.completion_tokens;
    const generatedTokens = Number.isInteger(tokens) && tokens! >= 0 ? tokens! : null;
    return {durationMs: reply.stats?.elapsed_ms ?? undefined, generatedTokens, estimatedTokens: false,
      generationTps: reply.stats?.generation_tps, estimatedGenerationTps: reply.stats?.generation_source === 'estimate',
      ...replayTotalTokens(reply.usage, generatedTokens, false),
      status: reply.interrupted ? 'cancelled' : reply.finish === 'error' ? 'failed' : 'completed'};
  }
  private persistReplayRuns() {
    try {localStorage.setItem(REPLAY_HISTORY_KEY, JSON.stringify(boundedReplayRuns(this.replayRuns)));}
    catch {this.replayNotice = 'Prompt run history could not be saved; browser storage may be full.';}
  }
  private rememberReplayRun(run: ReplayRun) {
    const next = boundedReplayRuns([...this.replayRuns, run]);
    if (!next.some(saved => saved.id === run.id)) {
      this.replayNotice = 'This prompt is too large to keep in replay history.';
      return;
    }
    this.replayRuns = next;
    this.persistReplayRuns();
  }
  private updateReplayRun(id: string, update: Partial<ReplayRun>, persist = true) {
    this.replayRuns = this.replayRuns.map(run => run.id === id ? {...run, ...update} : run);
    if (persist) this.persistReplayRuns();
  }
  private toggleReplayRun(id: string, checked: boolean) {
    this.selectedRunIds = checked
      ? [...new Set([...this.selectedRunIds, id])]
      : this.selectedRunIds.filter(selected => selected !== id);
  }
  private stopReplayBatch() {this.replayBatchController?.abort();}
  /** First content token replaces the histogram span. Later tokens in the same batch keep it open. */
  private noteGenerationOutput(startedAt = Date.now()) {
    if (!this.openGenerationSpan) return;
    this.generationFirstAt = Number.isFinite(startedAt) ? startedAt : Date.now();
    this.generationEndAt = null;
    this.openGenerationSpan = false;
  }
  /** Freeze the span when the chat or replay batch ends. No content leaves the previous span alone. */
  private closeGenerationSpan() {
    if (!this.openGenerationSpan && this.generationFirstAt != null && this.generationEndAt == null) {
      this.generationEndAt = Math.max(Date.now(), this.sampledAt);
    }
    this.openGenerationSpan = false;
  }
  /** Plot a provider reply on the same charts the local engine probe uses. */
  private recordExternalProbe(probe: EngineProbe, at = Date.now()) {
    if (!this.external) return;
    if (probe.generationTps == null && probe.prefillTps == null && probe.ttftSeconds == null) return;
    let stamp = at;
    if (this.lastExternalSampleAt && stamp <= this.lastExternalSampleAt) stamp = this.lastExternalSampleAt + 1;
    this.lastExternalSampleAt = stamp;
    this.probeRows = recordProbeRing(this.ringKey(), probe, stamp, probe);
    this.sampledAt = stamp;
  }
  private sampleExternalLive(live: LiveTurnStats) {
    if (!this.external || live.ttft_ms == null) return;
    const now = Date.now();
    if (this.lastExternalSampleAt && now - this.lastExternalSampleAt < 1000) return;
    const decodeMs = Math.max(0, live.elapsed_ms - live.ttft_ms);
    const generated = live.generated_tokens;
    const generationTps = generated != null && generated > 1 && decodeMs > 0 ? (generated - 1) * 1000 / decodeMs : null;
    this.recordExternalProbe({generationTps, prefillTps: null, ttftSeconds: null}, now);
  }
  private sampleExternalFinal(stats: {generation_tps: number | null; prefill_tps: number | null; ttft_ms: number | null}) {
    this.recordExternalProbe({
      generationTps: stats.generation_tps,
      prefillTps: stats.prefill_tps,
      ttftSeconds: stats.ttft_ms == null ? null : stats.ttft_ms / 1000,
    });
  }
  private async replayOne(run: ReplayRun, signal: AbortSignal, onProgress: (progress: ReplayProgress) => void) {
    const modelId = run.modelId;
    const start = performance.now();
    const clock = new TurnClock(start);
    const reducer = new ChatStreamReducer();
    const response = await this.postChat(run.request, signal);
    if (!response.ok) {
      const text = await response.text();
      let detail: unknown = text;
      try {const parsed = JSON.parse(text); detail = parsed.detail || parsed.error?.message || parsed.error || text;} catch { /* text error */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    if (!response.body) throw new Error('No inference stream returned');
    for await (const chunk of readChatStream(response.body, {signal})) {
      if (hasStreamOutput(chunk)) this.noteGenerationOutput(this.replaySpanStart);
      const now = performance.now();
      clock.observe(chunk, now);
      reducer.feed(chunk);
      if (reducer.state.error) throw new Error(reducer.state.error.message);
      if (reducer.state.content.length + (reducer.state.reasoning?.length || 0) + JSON.stringify(reducer.state.toolCalls).length > MAX_RESPONSE_CHARS) throw new Error('Response exceeded the 8 Mi-character limit');
      const live = clock.live(reducer.state, now);
      this.sampleExternalLive(live);
      const decodeMs = Math.max(0, live.elapsed_ms - (live.ttft_ms ?? live.elapsed_ms));
      const tokensPerSecond = live.generated_tokens && decodeMs > 0 ? live.generated_tokens * 1000 / decodeMs : null;
      onProgress({durationMs: live.elapsed_ms, generatedTokens: live.generated_tokens, estimatedTokens: live.estimated,
        generationTps: tokensPerSecond, ...replayTotalTokens(reducer.state.usage, live.generated_tokens, live.estimated)});
    }
    const state = reducer.end();
    if (signal.aborted) throw new DOMException('Replay cancelled', 'AbortError');
    if (!state.finish) throw new Error('Stream ended before a completion marker');
    const stats = clock.finish(state, performance.now(), false);
    this.sampleExternalFinal(stats);
    const generated = clock.live(state, performance.now());
    const usage = state.usage;
    const generatedTokens = generated.generated_tokens;
    const totals = replayTotalTokens(usage, generatedTokens, generated.estimated);
    return {result: '', status: 'completed' as const, durationMs: stats.elapsed_ms ?? performance.now() - start,
      generatedTokens, estimatedTokens: generated.estimated, generationTps: stats.generation_tps,
      estimatedGenerationTps: stats.generation_source === 'estimate', ...totals};
  }
  private async replaySelected() {
    const model = this.model;
    if (!model?.healthy || this.stale || this.busy || this.replayBusy) return;
    const selected = this.visibleReplayRuns.filter(run => this.selectedRunIds.includes(run.id));
    if (!selected.length) return;
    const cap = Math.max(1, Math.min(this.replayConcurrency || this.replayLimit, this.replayLimit));
    const controller = this.replayBatchController = new AbortController();
    this.replayBusy = true; this.replayNotice = '';
    this.replaySpanStart = Date.now();
    this.lastExternalSampleAt = 0;
    this.openGenerationSpan = true;
    this.replayProgress.clear(); this.replayNow = Date.now();
    this.replayTimer = setInterval(() => {this.replayNow = Date.now();}, 1000);
    for (const run of selected) this.updateReplayRun(run.id, {status: 'queued', result: ''}, false);
    this.requestUpdate(); this.persistReplayRuns();
    const batchStarted = performance.now();
    const spreadMs = this.replayPacing === 'staggered'
      ? Math.max(0, Math.min(30, Number(this.replaySpreadSeconds) || 0)) * 1000 : 0;
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const index = next++;
        const run = selected[index];
        const due = batchStarted + (selected.length < 2 ? 0 : index * spreadMs / (selected.length - 1));
        try {await waitUntil(due - performance.now(), controller.signal);}
        catch {this.updateReplayRun(run.id, {status: 'cancelled', result: 'Cancelled before start'}); continue;}
        if (controller.signal.aborted) {this.updateReplayRun(run.id, {status: 'cancelled', result: 'Cancelled before start'}); continue;}
        const request = new AbortController();
        this.replayControllers.add(request);
        const abort = () => request.abort();
        controller.signal.addEventListener('abort', abort, {once: true});
        this.replayProgress.set(run.id, {durationMs: 0, generatedTokens: 0, estimatedTokens: true, generationTps: null, totalTokens: null, estimatedTotalTokens: false});
        this.updateReplayRun(run.id, {status: 'running', lastReplayAt: Date.now(), result: '', durationMs: undefined, generatedTokens: null, generationTps: null, totalTokens: null});
        try {
          const result = await this.replayOne(run, request.signal, progress => this.replayProgress.set(run.id, progress));
          this.updateReplayRun(run.id, result);
        } catch (err) {
          const cancelled = request.signal.aborted;
          this.updateReplayRun(run.id, {status: cancelled ? 'cancelled' : 'failed', result: cancelled ? 'Cancelled' : (err instanceof Error ? err.message : String(err)).slice(0, 240)});
        } finally {
          this.replayProgress.delete(run.id);
          controller.signal.removeEventListener('abort', abort);
          this.replayControllers.delete(request);
        }
      }
    };
    try {
      await Promise.all(Array.from({length: Math.min(cap, selected.length)}, () => worker()));
    } finally {
      if (this.replayBatchController === controller) this.replayBatchController = null;
      if (this.replayTimer) clearInterval(this.replayTimer);
      this.replayTimer = null; this.replayProgress.clear();
      this.closeGenerationSpan();
      this.replayBusy = false;
    }
  }
  private get pending(): ToolCall[] {
    let pending: ToolCall[] = [];
    for (const m of this.messages) {
      if (m.role === 'assistant') pending = m.interrupted ? [] : m.tool_calls || [];
      if (m.role === 'tool') pending = pending.filter(t => t.id !== m.tool_call_id);
    }
    return pending;
  }
  private get interrupted() { return this.messages.some(m => m.interrupted); }
  private activate(conversation: Conversation) {
    if (this.activeId !== conversation.id) {this.previewCounts = {}; this.previewSelection = '';}
    this.activeId = conversation.id; this.currentByModel.set(conversation.modelId, conversation.id);
    this.messages = [...conversation.messages]; this.setup = normalizeSetup(conversation.setup);
    this.notice = this.setup.max_tokens !== conversation.setup.max_tokens ? `Saved max tokens adjusted from ${conversation.setup.max_tokens} to ${this.setup.max_tokens}.` : '';
    this.draft = ''; this.toolResults = {}; this.error = ''; this.lastRequest = null;
    this.liveStats = null;
  }
  private startConversation() {
    const conversation = newConversation(this.model?.id || '', this.setup);
    this.conversations = [...this.conversations.filter(c => c.messages.length), conversation]; this.activate(conversation);
  }
  private sync(id: string, messages: Message[], newMessage = false) {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;
    conversation.messages = messages;
    if (newMessage) conversation.updatedAt = Date.now();
    conversation.title = messages.find(m => m.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 60) || 'New conversation';
    if (id === this.activeId) {conversation.setup = {...this.setup}; this.messages = [...messages];}
  }
  private persist(streamingId?: string) {
    try {
      const candidates = this.conversations.map(c => c.id === streamingId ? {...c, messages: c.messages.map((m, i) => i === c.messages.length - 1 ? {...m, interrupted: true, finish: 'interrupted'} : m)} : c);
      const stored = boundedConversations(candidates, this.activeId);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(stored));
      const keptIds = new Set(stored.map(c => c.id));
      this.conversations = this.conversations.filter(c => keptIds.has(c.id) || !c.messages.length && c.id === this.activeId);
    } catch (err) {this.notice = err instanceof Error ? `History could not be saved: ${err.message}` : 'History could not be saved; export your conversation.';}
  }
  private selectConversation(id: string) {
    if (this.busy) return;
    const current = this.conversations.find(c => c.id === this.activeId); if (current) current.setup = {...this.setup};
    this.persist();
    const conversation = this.conversations.find(c => c.id === id && c.modelId === this.model?.id);
    if (conversation) {this.activate(conversation); this.persist();}
  }

  private async send(toolContinuation = false, importedRequest = false) {
    const model = this.model;
    if (!model?.healthy || this.busy || this.replayBusy || this.stale || this.interrupted) return;
    const old = [...this.messages];
    let submittedPrompt: string | null = null;
    if (toolContinuation) {
      if (this.pending.some(t => !this.toolResults[t.id]?.trim())) {this.error = 'Enter a result for each tool call.'; return;}
      for (const call of this.pending) old.push({role: 'tool', tool_call_id: call.id, content: this.toolResults[call.id]});
    } else {
      if (this.pending.length) return;
      if (this.draft.trim()) {submittedPrompt = this.draft.trim(); old.push({role: 'user', content: submittedPrompt});}
      else if (old[old.length - 1]?.role === 'user') submittedPrompt = old[old.length - 1].content;
      else if (!importedRequest || !old.length) return;
    }
    let body: Record<string, unknown>;
    let replayBody: Record<string, unknown> | null = null;
    try {
      const engine = model.engine || this.generationDefaults?.engine || null;
      body = buildRequest(this.setup, old, this.generationDefaults, engine);
      if (submittedPrompt !== null) replayBody = buildRequest(this.setup, [{role: 'user', content: submittedPrompt}], this.generationDefaults, engine);
    }
    catch (err) {this.error = err instanceof Error ? err.message : String(err); return;}
    let replayRunId: string | null = null;
    if (submittedPrompt !== null && replayBody) {
      const snapshot = replayThinkingSnapshot(this.setup, this.generationDefaults, replayBody);
      replayRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      this.rememberReplayRun({
        id: replayRunId, messageIndex: old.length - 1,
        modelId: model.id, conversationId: this.activeId, at: Date.now(), user: submittedPrompt,
        system: this.setup.system, temperature: this.setup.temperature.trim(), top_p: this.setup.top_p.trim(),
        max_tokens: Number(replayBody.max_tokens), thinkingEnabled: snapshot.enabled, effortLabel: snapshot.effortLabel,
        request: replayBody, status: 'ready'
      });
    }
    const assistant: Message = {role: 'assistant', content: ''};
    const conversation = [...old, assistant];
    const conversationId = this.activeId;
    const controller = this.controller = new AbortController();
    this.busy = true; this.error = ''; this.notice = ''; this.draft = ''; this.toolResults = {}; this.lastRequest = body;
    this.lastExternalSampleAt = 0;
    this.openGenerationSpan = true;
    this.sync(conversationId, conversation, true);
    this.persist(conversationId);
    const reducer = new ChatStreamReducer();
    const clock = new TurnClock(performance.now());
    this.startTokenWatch();
    this.liveClock = clock; this.liveState = reducer.state;
    this.liveStats = clock.live(reducer.state, performance.now());
    let arrival = performance.now();
    try {
      const response = await this.postChat(body, controller.signal);
      if (!response.ok) {
        const text = await response.text();
        let detail: unknown = text;
        try {const parsed = JSON.parse(text); detail = parsed.detail || parsed.error?.message || parsed.error || text;} catch { /* text error */ }
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      const effective = Number(response.headers.get('X-Effective-Max-Tokens'));
      if (this.controller === controller && Number.isInteger(effective) && effective > 0) {
        this.lastRequest = {...body, max_tokens: effective};
        if (effective < Number(body.max_tokens)) this.notice = `Output budget adjusted to ${effective.toLocaleString()} tokens to leave room for the prompt within the engine context window.`;
      }
      if (!response.body) throw new Error('No inference stream returned');
      for await (const chunk of readChatStream(response.body, {signal: controller.signal, onArrival: at => {arrival = at;}})) {
        if (hasStreamOutput(chunk)) {
          this.lastOutputAt = arrival; this.tokenWaitSeconds = 0;
          this.noteGenerationOutput();
        }
        clock.observe(chunk, arrival);
        reducer.feed(chunk);
        if (this.controller === controller) {
          this.liveStats = clock.live(reducer.state, arrival);
          this.sampleExternalLive(this.liveStats);
        }
        if (reducer.state.error) throw new Error(reducer.state.error.message);
        Object.assign(assistant, {content: reducer.state.content, reasoning: reducer.state.reasoning, tool_calls: [...reducer.state.toolCalls]});
        if (assistant.content.length + (assistant.reasoning?.length || 0) + JSON.stringify(assistant.tool_calls).length > MAX_RESPONSE_CHARS) {this.error = 'Response exceeded the 8 Mi-character display limit'; controller.abort(); throw new Error(this.error);}
        this.sync(conversationId, conversation);
      }
      if (controller.signal.aborted) assistant.interrupted = true;
      else if (!reducer.state.finish) throw new Error('Inference stream ended before a completion marker');
    } catch (err) {
      assistant.interrupted = true;
      if (this.controller === controller && !controller.signal.aborted) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      const state = reducer.end();
      const ended = performance.now();
      const outputLimit = Number(body.max_tokens);
      let usageEstimated = false;
      if (!state.usage) {
        const promptText = old.map(message => [message.content, message.reasoning, ...(message.tool_calls || []).map(call => `${call.function.name} ${call.function.arguments}`)].filter(Boolean).join('\n')).join('\n');
        const completionText = [state.reasoning, state.content, ...state.toolCalls.map(call => `${call.function.name} ${call.function.arguments}`)].filter(Boolean).join('\n');
        const prompt = estimateTokenCount(promptText);
        const completion = estimateTokenCount(completionText);
        if (prompt > 0 || completion > 0) {
          const reasoningChars = state.reasoning.trim().length;
          const answerChars = state.content.trim().length;
          const thinking = reasoningChars > 0 ? Math.round(completion * reasoningChars / Math.max(1, reasoningChars + answerChars)) : undefined;
          state.usage = {
            prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
            ...(thinking != null ? {completion_tokens_details: {reasoning_tokens: thinking}} : {}),
          };
          usageEstimated = true;
        }
      }
      const stats = clock.finish(state, ended, !!assistant.interrupted);
      const generated = clock.live(state, ended);
      const cost = usageEstimated ? null : turnCostUsd(state.usage, this.model?.price);
      Object.assign(assistant, {
        content: state.content, reasoning: state.reasoning, tool_calls: [...state.toolCalls],
        usage: state.usage, stats, finish: assistant.interrupted ? 'interrupted' : state.finish,
        ...(usageEstimated ? {usage_estimated: true} : {}),
        ...(Number.isInteger(outputLimit) && outputLimit > 0 ? {output_limit: outputLimit} : {}),
        ...(cost != null ? {cost_usd: cost} : {}),
      });
      this.sampleExternalFinal(stats);
      if (replayRunId) this.updateReplayRun(replayRunId, {
        durationMs: stats.elapsed_ms ?? generated.elapsed_ms,
        generatedTokens: generated.generated_tokens, estimatedTokens: generated.estimated,
        generationTps: stats.generation_tps, estimatedGenerationTps: stats.generation_source === 'estimate',
        ...replayTotalTokens(state.usage, generated.generated_tokens, generated.estimated),
        status: assistant.interrupted ? controller.signal.aborted ? 'cancelled' : 'failed' : 'completed',
      });
      this.sync(conversationId, conversation); this.persist();
      if (this.controller === controller) {
        this.closeGenerationSpan();
        this.liveStats = {...clock.live(state, performance.now()), elapsed_ms: assistant.stats!.elapsed_ms ?? 0, ttft_ms: assistant.stats!.ttft_ms};
        this.stopTokenWatch(); this.busy = false; this.controller = null;
      }
    }
  }
  private startTokenWatch() {
    this.stopTokenWatch(); this.lastOutputAt = performance.now();
    this.progressTimer = setInterval(() => {
      this.tokenWaitSeconds = Math.max(0, Math.floor((performance.now() - this.lastOutputAt) / 1000));
      if (this.liveClock && this.liveState) {
        this.liveStats = this.liveClock.live(this.liveState, performance.now());
        this.sampleExternalLive(this.liveStats);
      }
    }, 100);
  }
  private stopTokenWatch() {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null; this.tokenWaitSeconds = 0;
    this.liveClock = null; this.liveState = null;
  }
  private get displayedStats(): LiveTurnStats | null {
    if (this.liveStats) return this.liveStats;
    const message = [...this.messages].reverse().find(m => m.role === 'assistant');
    if (!message?.stats) return null;
    return {elapsed_ms: message.stats.elapsed_ms ?? 0, ttft_ms: message.stats.ttft_ms,
      generated_tokens: message.usage?.completion_tokens ?? null, estimated: false};
  }
  private clear() {if (this.busy) return; this.persist(); this.startConversation(); this.error = '';}
  private importConversation(send = false) {
    if (this.busy || this.replayBusy || !this.model) return;
    try {
      const imported = importChatRequest(this.importText);
      const current = this.conversations.find(c => c.id === this.activeId);
      if (current) current.setup = {...this.setup};
      this.persist();
      this.setup = imported.setup;
      this.presetName = '';
      this.startConversation();
      this.sync(this.activeId, imported.messages, true);
      this.importError = ''; this.importOpen = false; this.importText = '';
      this.notice = `Imported ${imported.messages.length} messages. Requests use the selected model, ${this.model.name}.`;
      this.persist();
      if (send) void this.send(false, true);
    } catch (err) {this.importError = err instanceof Error ? err.message : String(err);}
  }
  private renderImport() {
    if (!this.importOpen) return nothing;
    return html`<div class="request-import">
      <label>Chat request JSON<textarea class="tools-editor" aria-label="Chat request JSON" .value=${this.importText} @input=${(event: Event) => {this.importText = (event.target as HTMLTextAreaElement).value; this.importError = '';}} placeholder='{"messages":[{"role":"user","content":"Hello"}]}' ?disabled=${this.busy || this.replayBusy}></textarea></label>
      <p class="context-note">Paste a complete request or a messages array. Import starts a new conversation. Sending uses the selected model and streams its answer.</p>
      ${this.importError ? html`<p class="notice error" role="alert">${this.importError}</p>` : nothing}
      <div class="log-controls"><button @click=${() => this.importConversation()} ?disabled=${this.busy || this.replayBusy || !this.model || !this.importText.trim()}>Import conversation</button><button @click=${() => this.importConversation(true)} ?disabled=${this.busy || this.replayBusy || !this.model?.healthy || this.stale || !this.importText.trim()}>Import & send</button><button @click=${() => {this.importOpen = false; this.importError = '';}}>Cancel</button></div>
    </div>`;
  }
  private discard() {if (this.busy) return; this.sync(this.activeId, this.messages.filter(m => !m.interrupted)); this.error = ''; this.persist();}
  private deleteConversation() {
    if (this.busy) return;
    this.conversations = this.conversations.filter(c => c.id !== this.activeId);
    this.startConversation(); this.persist();
  }
  private savePreset() {
    const name = this.presetName.trim(); if (!name) {this.error = 'Name the preset first.'; return;}
    const presets = [...this.presets.filter(p => p.name !== name), {name, setup: {...this.setup}}];
    try {localStorage.setItem('llm-dashboard-presets-v1', JSON.stringify(presets)); this.presets = presets; this.notice = `Saved preset: ${name}`;}
    catch {this.error = 'This browser could not save the preset.';}
  }
  private exportChat() {
    const blob = new Blob([JSON.stringify({version: 1, model_id: this.model?.id, setup: this.setup, messages: this.messages, request: this.lastRequest}, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `conversation-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async copyMessage(message: Message) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message.content);
      else {
        const previous = document.activeElement as HTMLElement | null;
        const input = document.createElement('textarea'); input.value = message.content; input.readOnly = true;
        input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
        document.body.append(input);
        try {input.select(); if (!document.execCommand('copy')) throw new Error('Copy unavailable');}
        finally {input.remove(); previous?.focus();}
      }
      this.copied = message; if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {this.copied = null;}, 2000);
    } catch {this.error = 'Copy failed. Select the message text to copy it.';}
  }
  private userCopy(message: Message) {
    if (message.role !== 'user') return nothing;
    const copied = this.copied === message;
    return html`<button class="message-copy" aria-label=${copied ? 'User message copied' : 'Copy user message'} title=${copied ? 'Copied' : 'Copy message'} @click=${() => void this.copyMessage(message)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${copied ? svg`<path d="m5 12 4 4 10-10"/>` : svg`<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>`}</svg>${copied ? html`<span class="sr-only" role="status">Copied</span>` : nothing}</button>`;
  }
  private answerKey(index: number) {return this.activeId + ':' + index;}
  private get hasAnswers() {return this.messages.some(m => m.role === 'assistant' && m.content.trim());}
  private get previewChoices() {
    let reply = 0;
    return this.messages.flatMap((message, index) => {
      if (message.role !== 'assistant') return [];
      reply++;
      if (!message.content.trim()) return [];
      const viewKey = this.answerKey(index), count = this.previewCounts[viewKey] || 0;
      return Array.from({length: count}, (_, document) => ({id: viewKey + ':' + document, viewKey, document, label: 'Reply ' + reply + (count > 1 ? ' · HTML ' + (document + 1) : '')}));
    });
  }
  private get selectedPreview() {
    const choices = this.previewChoices;
    return choices.find(choice => choice.id === this.previewSelection) || choices.find(choice => choice.viewKey === choices.at(-1)?.viewKey);
  }
  private answerCapabilities(event: CustomEvent<{viewKey: string; documents: number}>) {
    const {viewKey, documents} = event.detail;
    if (!viewKey.startsWith(this.activeId + ':') || this.previewCounts[viewKey] === documents) return;
    this.previewCounts = {...this.previewCounts, [viewKey]: documents};
  }
  private previewHTML() {
    const selection = this.selectedPreview; if (this.busy || !selection) return;
    const viewer = [...this.querySelectorAll<AnswerView>('spark-answer-view')].find(view => view.viewKey === selection.viewKey);
    viewer?.preview(selection.document);
  }
  private trackScroll(event: Event) {
    if (this.conversationCollapsed) return;
    const box = event.currentTarget as HTMLElement; this.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  private followAnswer() {
    const box = this.querySelector('.chat-messages'); if (box && this.follow && !this.conversationCollapsed) box.scrollTop = box.scrollHeight;
  }
  private renderReplayHistory() {
    const runs = this.visibleReplayRuns;
    const selectedCount = runs.filter(run => this.selectedRunIds.includes(run.id)).length;
    const limit = this.replayLimit;
    const concurrency = Math.max(1, Math.min(this.replayConcurrency || limit, limit));
    return html`<section class="panel replay-panel">
      <div class="panel-heading replay-heading"><div><h2>Prompt runs</h2><span>${selectedCount} selected · up to ${concurrency} concurrent</span></div>
        <div class="replay-controls">
          <label>Concurrency<select aria-label="Replay concurrency" .value=${String(concurrency)} ?disabled=${this.replayBusy} @change=${(event: Event) => {this.replayConcurrency = Number((event.target as HTMLSelectElement).value);}}>${Array.from({length: limit}, (_, index) => index + 1).map(value => html`<option value=${String(value)}>${value}${value === limit ? ' · engine limit' : ''}</option>`)}</select></label>
          <label>Start pattern<select aria-label="Replay start pattern" .value=${this.replayPacing} ?disabled=${this.replayBusy} @change=${(event: Event) => {this.replayPacing = (event.target as HTMLSelectElement).value as 'simultaneous' | 'staggered';}}><option value="simultaneous">Simultaneous</option><option value="staggered">Staggered</option></select></label>
          ${this.replayPacing === 'staggered' ? html`<label>Spread over<input aria-label="Stagger spread seconds" type="number" min="0" max="30" step="0.5" .value=${this.replaySpreadSeconds} ?disabled=${this.replayBusy} @input=${(event: Event) => {this.replaySpreadSeconds = (event.target as HTMLInputElement).value;}}><span>s</span></label>` : nothing}
          <button ?disabled=${!selectedCount || !this.model?.healthy || this.stale || this.busy || this.replayBusy} @click=${() => void this.replaySelected()}>Replay selected</button>
          ${this.replayBusy ? html`<button @click=${this.stopReplayBatch}>Stop batch</button>` : nothing}
        </div>
      </div>
      ${this.replayNotice ? html`<p class="context-note" role="status">${this.replayNotice}</p>` : nothing}
      ${runs.length ? html`<div class="table-scroll replay-scroll"><table class="replay-table"><thead><tr><th scope="col">Select</th><th scope="col">Timestamp</th><th scope="col">User<br>prompt</th><th scope="col">System<br>prompt</th><th scope="col">Temp</th><th scope="col">Effort</th><th scope="col">Top P</th><th scope="col">Max<br>tokens</th><th scope="col">Time</th><th scope="col">Tokens</th><th scope="col">Latest<br>run</th></tr></thead><tbody>
        ${runs.map(run => {
          const progress = this.replayProgress.get(run.id);
          const running = run.status === 'running';
          const oldSpeed = Number(run.result?.match(/(?:≈\s*)?([\d.]+) tok\/s/)?.[1]);
          const oldTotalText = run.result?.match(/(≈\s*)?total ([\d,]+) tokens/);
          const oldTotal = oldTotalText ? Number(oldTotalText[2].replaceAll(',', '')) : null;
          const elapsedMs = running ? (this.replayNow - (run.lastReplayAt || this.replayNow)) : run.durationMs;
          const generatedTokens = running ? progress?.generatedTokens : run.generatedTokens;
          const tokenEstimate = running ? progress?.estimatedTokens : run.estimatedTokens;
          const totalTokens = running ? progress?.totalTokens : run.totalTokens ?? (Number.isFinite(oldTotal) ? oldTotal : null);
          const totalEstimate = running ? progress?.estimatedTotalTokens : run.estimatedTotalTokens || !!oldTotalText?.[1];
          const speed = running ? progress?.generationTps : run.generationTps ?? (Number.isFinite(oldSpeed) ? oldSpeed : null);
          const speedEstimate = running || run.estimatedGenerationTps || /≈\s*[\d.]+ tok\/s/.test(run.result || '');
          const completed = run.status === 'completed';
          return html`<tr>
          <td><input type="checkbox" aria-label=${'Select replay for ' + run.user.slice(0, 80)} .checked=${this.selectedRunIds.includes(run.id)} ?disabled=${this.replayBusy} @change=${(event: Event) => this.toggleReplayRun(run.id, (event.target as HTMLInputElement).checked)}></td>
          <td class="replay-time" title=${run.source === 'conversation-history' ? 'Approximate: individual turn timestamps were not stored; this is the conversation’s last saved time.' : ''}>${run.source === 'conversation-history' ? '~ ' : ''}${conversationTimestamp(run.at)}</td>
          <td class="replay-prompt" title=${run.user}>${run.user}</td>
          <td class="replay-prompt" title=${run.system || 'No system prompt'}>${run.system || '—'}</td>
          <td>${run.temperature || 'Default'}</td><td>${run.effortLabel}</td><td>${run.top_p || 'Default'}</td><td>${run.max_tokens.toLocaleString()}</td>
          <td class="replay-number">${elapsedMs == null ? '—' : running ? replayElapsed(elapsedMs) : `${Math.round(elapsedMs / 1000)} s`}</td><td class="replay-number" title=${tokenEstimate ? 'Estimated from generated text because engine token usage was unavailable.' : 'Generated tokens reported by the engine.'}>${generatedTokens == null ? '—' : `${tokenEstimate ? '≈ ' : ''}${generatedTokens.toLocaleString()}`}</td>
          <td class="replay-result">
            ${running ? html`<span class="replay-latest running" title="Live t/s and generated-token count; final token count uses engine usage when reported.">${replayElapsed(elapsedMs || 0)} · ${speed == null ? '—' : `≈ ${Math.round(speed)}`} t/s · ${totalTokens == null ? `${tokenEstimate ? '≈ ' : ''}${generatedTokens?.toLocaleString() || '0'} generated` : `${totalEstimate ? '≈ ' : ''}${totalTokens.toLocaleString()} tokens`}</span>` : nothing}
            ${completed ? html`<span class="replay-latest completed" title=${totalEstimate ? 'Token count is estimated because the engine omitted complete usage.' : 'Final run token count reported by the engine.'}>${elapsedMs == null ? '—' : `${Math.round(elapsedMs / 1000)} s`} · ${speed == null ? '—' : `${speedEstimate ? '≈ ' : ''}${Math.round(speed)} t/s`} · ${totalTokens == null ? '— tokens' : `${totalEstimate ? '≈ ' : ''}${totalTokens.toLocaleString()} tokens`}</span>` : nothing}
            ${!running && !completed ? html`<span class=${'replay-status ' + run.status}>${run.status === 'ready' ? 'Ready' : run.status === 'queued' ? 'Queued' : run.status === 'failed' ? 'Failed' : 'Cancelled'}</span>${run.result ? html`<span class="cell-detail" title=${run.result}>${run.result}</span>` : nothing}` : nothing}
          </td>
        </tr>`;
        })}
      </tbody></table></div>` : html`<div class="panel-empty">Prompts you send will appear here as fresh-request replay cases.</div>`}
      <p class="context-note replay-footnote">Each replay sends a fresh request with only the saved system and user prompts. Blank sampling values and model-default thinking remain omitted as they were in the original request. Staggering spaces starts evenly across the selected time window.${runs.some(run => run.source === 'conversation-history') ? ' Imported conversation prompts use the saved conversation settings and an approximate timestamp because older history did not retain per-turn settings or times.' : ''}</p>
    </section>`;
  }
  render() {
    const choices = this.previewChoices, selected = this.selectedPreview;
    const conversations = this.conversations.filter(c => c.modelId === this.model?.id).sort((a, b) => b.updatedAt - a.updatedAt);
    return html`<div class="chat-layout" @answer-rendered=${this.followAnswer} @answer-capabilities=${this.answerCapabilities} @window-change=${this.pickWindow}><div class="conversation-column"><section class="panel chat-panel ${this.conversationCollapsed ? 'collapsed' : ''}"><div class="panel-heading" @click=${this.toggleConversationFromHeader}><div class="conversation-heading"><h2><button class="conversation-toggle" aria-expanded=${!this.conversationCollapsed} aria-controls="conversation-body" @click=${() => {this.conversationCollapsed = !this.conversationCollapsed;}}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4"/></svg>Conversation</button></h2><select aria-label="Past conversations" ?disabled=${this.busy || this.replayBusy} @change=${(e: Event) => this.selectConversation((e.target as HTMLSelectElement).value)}>${conversations.map(c => html`<option value=${c.id} .selected=${c.id === this.activeId}>${c.title}${c.messages.length ? ' · ' + conversationTimestamp(c.updatedAt) : ''}</option>`)}</select></div><div class="log-controls conversation-controls"><button aria-pressed=${this.hasAnswers && !this.sourceView} ?disabled=${!this.hasAnswers} @click=${() => {this.sourceView = false;}}>Markdown</button><button aria-pressed=${this.hasAnswers && this.sourceView} ?disabled=${!this.hasAnswers} @click=${() => {this.sourceView = true;}}>Source</button>${choices.length > 1 ? html`<select aria-label="HTML preview document" ?disabled=${this.busy || this.replayBusy} @change=${(event: Event) => {this.previewSelection = (event.target as HTMLSelectElement).value;}}>${choices.map(choice => html`<option value=${choice.id} .selected=${choice.id === selected?.id}>${choice.label}</option>`)}</select>` : nothing}<button ?disabled=${this.busy || this.replayBusy || !selected} title=${selected ? 'Preview HTML from ' + selected.label.toLowerCase() : 'No HTML answer in this conversation'} @click=${this.previewHTML}>Preview HTML</button><button @click=${() => {this.importOpen = !this.importOpen; this.importError = '';}} aria-expanded=${this.importOpen} ?disabled=${this.busy || this.replayBusy}>Import JSON</button><button @click=${this.exportChat} ?disabled=${!this.messages.length}>Export JSON</button><button @click=${this.clear} ?disabled=${this.busy || this.replayBusy}>New conversation</button><button @click=${this.deleteConversation} ?disabled=${this.busy || this.replayBusy || !this.messages.length}>Delete</button></div></div>
      <div id="conversation-body" class="conversation-body" ?hidden=${this.conversationCollapsed}>
      ${this.renderImport()}
      ${!this.model?.healthy || this.stale ? html`<div class="notice">Choose a healthy model with fresh status to send a message.</div>` : nothing}
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}${this.notice ? html`<p class="context-note" role="status">${this.notice}</p>` : nothing}
      ${this.busy && this.tokenWaitSeconds >= TOKEN_STALL_SECONDS ? html`<div class="notice error" role="status">No tokens received for ${this.tokenWaitSeconds} s. A long prefill, another request, or stalled generation may be delaying this reply while the API still responds.</div>` : nothing}
      <div class="chat-messages" aria-label="Conversation messages" @scroll=${this.trackScroll}>${this.messages.length ? this.messages.map((m, index) => html`<article class="chat-message ${m.role}"><div class="message-role">${m.role}${m.interrupted ? html`<span> · interrupted</span>` : nothing}${this.userCopy(m)}</div>${m.reasoning ? html`<details class="reasoning"><summary>Reasoning</summary><pre>${m.reasoning}</pre></details>` : nothing}${m.content ? m.role === 'assistant' ? html`<spark-answer-view .content=${m.content} .viewKey=${this.answerKey(index)} .plain=${this.sourceView} .streaming=${this.busy && m === this.messages[this.messages.length - 1]}></spark-answer-view>` : html`<div class="message-content">${m.content}</div>` : this.busy && m === this.messages[this.messages.length - 1] ? html`<span class="subtle">Waiting for tokens…</span>` : nothing}${m.tool_calls?.map(t => html`<div class="tool-call"><strong>${t.function.name || 'Tool call'}</strong><pre>${t.function.arguments}</pre></div>`)}${m.usage || m.stats || m.finish === 'length' ? renderTurnStatus(m) : nothing}${m.interrupted ? html`<button @click=${this.discard} ?disabled=${this.busy}>Discard interrupted reply</button>` : nothing}</article>`) : html`<div class="chat-empty">Start a conversation with ${this.model?.name || 'a model'}.<span>Answers and reasoning stream here. Tool results are entered manually.</span></div>`}</div>
      ${this.pending.length && !this.busy && !this.replayBusy ? html`<div class="tool-results"><h2>Tool results</h2><p class="context-note">Provide each function's result to continue the conversation.</p>${this.pending.map(t => html`<label>${t.function.name}<textarea aria-label=${`Result for ${t.function.name}`} .value=${this.toolResults[t.id] || ''} @input=${(e: Event) => {this.toolResults = {...this.toolResults, [t.id]: (e.target as HTMLTextAreaElement).value};}} placeholder="Enter the tool result"></textarea></label>`)}<button @click=${() => void this.send(true)} ?disabled=${!this.model?.healthy || this.stale || this.replayBusy}>Submit results & continue</button></div>` : nothing}
      <form class="composer" @submit=${(e: Event) => {e.preventDefault(); void this.send();}}><label class="sr-only" for="chat-prompt">Message</label><textarea id="chat-prompt" .value=${this.draft} @input=${(e: Event) => {this.draft = (e.target as HTMLTextAreaElement).value;}} ?disabled=${this.busy || this.replayBusy || !!this.pending.length} placeholder="Message the selected model…" @keydown=${(e: KeyboardEvent) => {if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {e.preventDefault(); void this.send();}}}></textarea><div class="composer-actions">${renderLiveStatus(this.displayedStats, this.busy)}${this.busy ? html`<button type="button" @click=${() => this.controller?.abort()}>Stop generation</button>` : html`<button type="submit" ?disabled=${!this.model?.healthy || this.stale || this.replayBusy || !!this.pending.length || this.interrupted || !this.draft.trim() && this.messages[this.messages.length - 1]?.role !== 'user'}>Send message</button>`}</div></form></div></section>
      <div class="playground-performance"><spark-metrics .rows=${this.probeRows} .now=${this.probe} .windowSeconds=${this.windowSeconds} .sampledAt=${this.sampledAt} .generationSpan=${this.generationFirstAt == null ? null : {firstAt: this.generationFirstAt, endAt: this.generationEndAt}}></spark-metrics></div>
      </div>
      <aside class="panel chat-settings"><div class="panel-heading"><h2>Generation settings</h2></div><fieldset ?disabled=${this.busy || this.replayBusy}><label>System prompt<textarea .value=${this.setup.system} @input=${(e: Event) => this.setupField('system', (e.target as HTMLTextAreaElement).value)} placeholder="Optional instructions"></textarea></label><div class="parameter-grid">${(['temperature', 'top_p'] as const).map(key => html`<label>${{temperature: 'Temperature', top_p: 'Top P'}[key]}<input type="number" step="0.1" .value=${this.setup[key]} @input=${(e: Event) => this.setupField(key, (e.target as HTMLInputElement).value)} placeholder=${this.samplingPlaceholder(key)} title=${'Engine default: ' + (this.generationDefaults?.engine_defaults[key] ?? 'not reported') + '; model metadata: ' + (this.generationDefaults?.model_defaults[key] ?? 'not available')}>${this.renderSamplingDefault(key)}</label>`)}<label>Top K<input aria-label="Top K" type="number" min="0" step="1" .value=${this.setup.top_k ?? ''} @input=${(e: Event) => this.setupField('top_k', (e.target as HTMLInputElement).value)} placeholder=${this.samplingPlaceholder('top_k')}>${this.renderSamplingDefault('top_k')}</label><label>Max tokens<select aria-label="Max tokens" @change=${(e: Event) => this.setupField('max_tokens', (e.target as HTMLSelectElement).value)}>${!MAX_TOKEN_CHOICES.includes(Number(this.setup.max_tokens)) ? html`<option value=${this.setup.max_tokens} selected>${Number(this.setup.max_tokens).toLocaleString()}</option>` : nothing}${MAX_TOKEN_CHOICES.map(value => html`<option value=${String(value)} .selected=${this.setup.max_tokens === String(value)}>${value.toLocaleString()}</option>`)}</select></label></div><label>Thinking<select aria-label="Thinking" @change=${(e: Event) => this.setupField('thinking', (e.target as HTMLSelectElement).value)}>${['default', 'on', 'off'].map(v => html`<option value=${v} .selected=${this.setup.thinking === v}>${v === 'default' ? defaultLabel(this.generationDefaults, 'enable_thinking') : v === 'on' ? 'Enabled' : 'Disabled'}</option>`)}</select></label><label>Reasoning effort<select aria-label="Reasoning effort" ?disabled=${!this.setup.request_effort && !thinkingEnabled(this.setup.thinking, this.generationDefaults)} @change=${(e: Event) => this.setupField('reasoning_effort', (e.target as HTMLSelectElement).value)}>${['', 'low', 'medium', 'high', 'xhigh'].map(v => html`<option value=${v} .selected=${this.setup.reasoning_effort === v}>${v === '' ? defaultLabel(this.generationDefaults, 'reasoning_effort') : v === 'xhigh' ? 'Extra high' : v === 'low' ? 'Low' : v === 'high' ? 'High' : 'Medium'}</option>`)}</select></label>${!this.setup.request_effort && !thinkingEnabled(this.setup.thinking, this.generationDefaults) ? html`<span class="subtle">Reasoning effort requires thinking to be enabled.</span>` : nothing}${this.renderPenaltyAndBudget()}${this.renderDefaultInfo()}<details><summary>Tools · JSON definitions</summary><textarea class="tools-editor" aria-label="Tool definitions" .value=${this.setup.tools} @input=${(e: Event) => this.setupField('tools', (e.target as HTMLTextAreaElement).value)} placeholder='[{"type":"function","function":{"name":"…","parameters":{…}}}]'></textarea></details><label>Preset name<input .value=${this.presetName} @input=${(e: Event) => {this.presetName = (e.target as HTMLInputElement).value;}} placeholder="Name your settings"></label><button @click=${this.savePreset}>Save preset</button>${this.presets.length ? html`<label>Load preset<select aria-label="Load preset" @change=${(e: Event) => {const p = this.presets.find(p => p.name === (e.target as HTMLSelectElement).value); if (p) {this.setup = normalizeSetup(p.setup); this.presetName = p.name;}}}><option value="">Choose a preset</option>${this.presets.map(p => html`<option value=${p.name}>${p.name}</option>`)}</select></label>` : nothing}</fieldset><details class="request-inspector"><summary>Last request · JSON</summary><pre>${this.lastRequest ? JSON.stringify(this.lastRequest, null, 2) : 'Send a message to inspect the request.'}</pre></details><p class="context-note">Presets and up to 30 past conversations are saved in this browser. Export JSON to keep a separate copy.</p></aside></div>${this.renderReplayHistory()}`;
  }
}
