/**
 * Which sampling controls an engine accepts, and any defaults it actually reports.
 * A missing default stays null — this module never fills one in.
 */

/** @typedef {"temperature" | "topP" | "topK" | "maxTokens" | "presencePenalty" | "thinking" | "reasoningEffort" | "thinkingBudget"} ControlKey */

/** @type {ControlKey[]} */
export const CONTROL_KEYS = [
  "temperature",
  "topP",
  "topK",
  "maxTokens",
  "presencePenalty",
  "thinking",
  "reasoningEffort",
  "thinkingBudget",
];

/**
 * OpenAI chat fields decode already sends (temperature, top_p, max_tokens).
 * Presence penalty is part of that same chat schema on the engines below.
 * @type {ControlKey[]}
 */
const OPENAI_CHAT = ["temperature", "topP", "maxTokens", "presencePenalty"];

/**
 * Extra fields those engines document on POST /v1/chat/completions.
 * Thinking budget is the Qwen-style `thinking_budget` / `reasoning_budget`
 * pair vLLM and SGLang take in chat template kwargs. Reasoning effort is
 * vLLM's `reasoning_effort`. Anything else stays off until a generation
 * config reports the key.
 * @type {Record<string, ControlKey[]>}
 */
const ENGINE_EXTRA = {
  vllm: ["topK", "thinking", "reasoningEffort", "thinkingBudget"],
  sglang: ["topK", "thinking", "thinkingBudget"],
  "llama.cpp": ["topK", "thinking"],
  ollama: ["topK", "thinking"],
  lmstudio: ["topK", "thinking"],
  exl3: ["topK"],
  ds4: ["thinking"],
  q27: ["topK"],
  tensorfold: [],
  freetoken: [],
};

const CONTAINER_KEYS = [
  "generation_config",
  "default_generation_settings",
  "generation_settings",
  "chat_template_kwargs",
  "sampling_params",
];

/**
 * @param {string | null | undefined} backend
 * @returns {Set<ControlKey>}
 */
export function staticAccepted(backend) {
  const extra = backend && ENGINE_EXTRA[backend] ? ENGINE_EXTRA[backend] : null;
  const fields = extra ? OPENAI_CHAT.concat(extra) : ["temperature", "topP", "maxTokens"];
  return new Set(fields);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asFinite(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * @param {unknown} node
 * @param {object[]} found
 * @param {number} depth
 */
function collectContainers(node, found, depth) {
  if (!node || typeof node !== "object" || depth > 5) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 20)) collectContainers(item, found, depth + 1);
    return;
  }
  for (const key of CONTAINER_KEYS) {
    const child = node[key];
    if (child && typeof child === "object" && !Array.isArray(child)) found.push(child);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectContainers(value, found, depth + 1);
  }
}

/**
 * @param {Record<string, unknown>} src
 * @param {Record<string, number | boolean | string>} defaults
 * @param {Set<string>} enabled
 */
function absorbFields(src, defaults, enabled) {
  const takeNumber = (key, control, { integer = false, positive = false } = {}) => {
    if (!Object.prototype.hasOwnProperty.call(src, key)) return;
    const n = asFinite(src[key]);
    if (n == null) return;
    if (integer && !Number.isInteger(n)) return;
    if (positive && n <= 0) return;
    enabled.add(control);
    if (!Object.prototype.hasOwnProperty.call(defaults, control)) defaults[control] = n;
  };

  takeNumber("temperature", "temperature");
  takeNumber("top_p", "topP");
  takeNumber("top_k", "topK", { integer: true, positive: true });
  takeNumber("presence_penalty", "presencePenalty");
  for (const key of ["max_tokens", "max_new_tokens", "n_predict"]) {
    takeNumber(key, "maxTokens", { integer: true, positive: true });
  }
  for (const key of ["thinking_budget", "reasoning_budget", "budget_tokens"]) {
    takeNumber(key, "thinkingBudget", { integer: true, positive: true });
  }

  if (typeof src.enable_thinking === "boolean") {
    enabled.add("thinking");
    if (!Object.prototype.hasOwnProperty.call(defaults, "thinking")) defaults.thinking = src.enable_thinking;
  } else if (typeof src.thinking === "boolean") {
    enabled.add("thinking");
    if (!Object.prototype.hasOwnProperty.call(defaults, "thinking")) defaults.thinking = src.thinking;
  } else if (src.thinking_mode === "enabled" || src.thinking_mode === "disabled") {
    enabled.add("thinking");
    if (!Object.prototype.hasOwnProperty.call(defaults, "thinking")) {
      defaults.thinking = src.thinking_mode === "enabled";
    }
  }

  if (typeof src.reasoning_effort === "string" && src.reasoning_effort.trim()) {
    enabled.add("reasoningEffort");
    if (!Object.prototype.hasOwnProperty.call(defaults, "reasoningEffort")) {
      defaults.reasoningEffort = src.reasoning_effort.trim();
    }
  }
}

/**
 * Ollama `/api/show` prints sampling as `key value` lines in `parameters`.
 * @param {string} text
 * @param {Record<string, number | boolean | string>} defaults
 * @param {Set<string>} enabled
 */
function absorbOllamaParameters(text, defaults, enabled) {
  const map = {
    temperature: "temperature",
    top_p: "top_p",
    top_k: "top_k",
    presence_penalty: "presence_penalty",
    num_predict: "n_predict",
  };
  /** @type {Record<string, unknown>} */
  const src = {};
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([a-z0-9_]+)\s+(\S+)/i);
    if (!match || !map[match[1]]) continue;
    src[map[match[1]]] = match[2];
  }
  absorbFields(src, defaults, enabled);
}

/**
 * @param {string | null | undefined} backend
 * @param {unknown[]} docs
 * @returns {Record<ControlKey, { enabled: boolean, default: number | boolean | string | null }>}
 */
export function samplingProfile(backend, docs) {
  const enabled = staticAccepted(backend);
  /** @type {Record<string, number | boolean | string>} */
  const defaults = {};
  for (const doc of docs || []) {
    if (!doc || typeof doc !== "object") continue;
    if (typeof doc.parameters === "string") absorbOllamaParameters(doc.parameters, defaults, enabled);
    /** @type {object[]} */
    const containers = [];
    collectContainers(doc, containers, 0);
    for (const container of containers) {
      absorbFields(container, defaults, enabled);
      if (container.params && typeof container.params === "object" && !Array.isArray(container.params)) {
        absorbFields(container.params, defaults, enabled);
      }
    }
  }

  /** @type {Record<string, { enabled: boolean, default: number | boolean | string | null }>} */
  const controls = {};
  for (const key of CONTROL_KEYS) {
    controls[key] = {
      enabled: enabled.has(key),
      default: Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : null,
    };
  }
  return controls;
}
