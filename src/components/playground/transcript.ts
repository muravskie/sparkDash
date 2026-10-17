/**
 * Conversation JSON and the sampling draft the playground stores.
 * Sampling values are strings so an empty control stays empty.
 */

export interface ToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface SamplingDraft {
  temperature: string;
  topP: string;
  topK: string;
  maxTokens: string;
  presencePenalty: string;
  thinking: "" | "on" | "off";
  reasoningEffort: string;
  thinkingBudget: string;
}

export interface SamplingControl {
  enabled: boolean;
  default: number | boolean | string | null;
}

export type SamplingControls = Record<keyof SamplingDraft, SamplingControl>;

export interface TranscriptFile {
  version: 1;
  messages: Omit<ChatMessage, "id">[];
  sampling: SamplingDraft;
  toolsText: string;
}

const ROLES = new Set<ChatRole>(["system", "user", "assistant", "tool"]);

export function blankSampling(): SamplingDraft {
  return {
    temperature: "",
    topP: "",
    topK: "",
    maxTokens: "",
    presencePenalty: "",
    thinking: "",
    reasoningEffort: "",
    thinkingBudget: "",
  };
}

export function samplingFromControls(controls: SamplingControls | null | undefined): SamplingDraft {
  const draft = blankSampling();
  if (!controls) return draft;
  (Object.keys(draft) as (keyof SamplingDraft)[]).forEach((key) => {
    const control = controls[key];
    if (!control?.enabled || control.default == null) return;
    if (key === "thinking") {
      draft.thinking = control.default === true ? "on" : control.default === false ? "off" : "";
      return;
    }
    draft[key] = String(control.default);
  });
  return draft;
}

/** Fields the server should see. Disabled controls are left out. */
export function samplingPayload(
  draft: SamplingDraft,
  controls: SamplingControls | null | undefined
): Partial<SamplingDraft> {
  const out: Partial<SamplingDraft> = {};
  (Object.keys(draft) as (keyof SamplingDraft)[]).forEach((key) => {
    if (controls && controls[key] && controls[key].enabled === false) return;
    Object.assign(out, { [key]: draft[key] });
  });
  return out;
}

let messageSeq = 0;

export function newMessageId(): string {
  messageSeq += 1;
  return `m${Date.now().toString(36)}${messageSeq.toString(36)}`;
}

function toolCall(raw: unknown, index: number): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const call = raw as Record<string, unknown>;
  const name = typeof call.name === "string" ? call.name : "";
  const args = typeof call.arguments === "string" ? call.arguments : "";
  const id = typeof call.id === "string" ? call.id : "";
  if (!name && !args && !id) return null;
  const idx = typeof call.index === "number" && Number.isInteger(call.index) ? call.index : index;
  return { index: idx, id, name, arguments: args };
}

function messageFromRaw(raw: unknown): Omit<ChatMessage, "id"> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const role = row.role;
  if (typeof role !== "string" || !ROLES.has(role as ChatRole)) return null;
  const content = typeof row.content === "string" ? row.content : "";
  const message: Omit<ChatMessage, "id"> = { role: role as ChatRole, content };
  if (typeof row.reasoning === "string" && row.reasoning) message.reasoning = row.reasoning;
  if (typeof row.name === "string" && row.name) message.name = row.name;
  const toolId = row.toolCallId ?? row.tool_call_id;
  if (typeof toolId === "string" && toolId) message.toolCallId = toolId;
  if (Array.isArray(row.toolCalls)) {
    const calls = row.toolCalls.map((call, index) => toolCall(call, index)).filter((call): call is ToolCall => call != null);
    if (calls.length) message.toolCalls = calls;
  }
  return message;
}

export function exportTranscript(messages: readonly ChatMessage[], sampling: SamplingDraft, toolsText: string): string {
  const file: TranscriptFile = {
    version: 1,
    messages: messages.map(({ id: _id, ...rest }) => rest),
    sampling: { ...sampling },
    toolsText,
  };
  return JSON.stringify(file, null, 2);
}

export function importTranscript(raw: string): { messages: ChatMessage[]; sampling: SamplingDraft; toolsText: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Conversation file is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Conversation file must be a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 1) throw new Error("Unsupported conversation version");
  if (!Array.isArray(doc.messages)) throw new Error("Conversation file has no messages");

  const messages = doc.messages.map(messageFromRaw).filter((message): message is Omit<ChatMessage, "id"> => message != null);
  if (doc.messages.length > 0 && messages.length === 0) {
    throw new Error("Conversation file has no readable messages");
  }

  const sampling = blankSampling();
  if (doc.sampling && typeof doc.sampling === "object" && !Array.isArray(doc.sampling)) {
    const saved = doc.sampling as Record<string, unknown>;
    (Object.keys(sampling) as (keyof SamplingDraft)[]).forEach((key) => {
      const value = saved[key];
      if (typeof value !== "string") return;
      if (key === "thinking" && value !== "" && value !== "on" && value !== "off") return;
      Object.assign(sampling, { [key]: value });
    });
  }

  let toolsText = "";
  if (typeof doc.toolsText === "string") toolsText = doc.toolsText;
  else if (Array.isArray(doc.tools)) toolsText = JSON.stringify(doc.tools, null, 2);

  return {
    messages: messages.map((message) => ({ ...message, id: newMessageId() })),
    sampling,
    toolsText,
  };
}

export function parseTools(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Tools must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("Tools must be a JSON array");
  return parsed;
}
