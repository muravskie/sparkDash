/**
 * Generation-defaults payload the copied playground renders under each input.
 * Numbers come from the engine documents this relay already reads, plus the
 * live vLLM / SGLang metadata endpoints that page queries.
 */

import { readEngineContext, readEngineDocument } from "./engineInfo.js";
import { samplingProfile } from "./sampling.js";

const RANGES = {
  temperature: [0, 2],
  top_p: [0, 1],
  top_k: [-1, 1_000_000],
  presence_penalty: [-2, 2],
  thinking_budget: [-1, 262144],
};

/**
 * @param {unknown} data
 */
export function samplingValues(data) {
  if (!data || typeof data !== "object") return {};
  /** @type {Record<string, number>} */
  const values = {};
  for (const [key, [low, high]] of Object.entries(RANGES)) {
    let value = data[key];
    if (value == null && key === "thinking_budget") value = data.thinking_token_budget;
    if (key === "thinking_budget" && value == null && (Object.prototype.hasOwnProperty.call(data, "thinking_budget") || Object.prototype.hasOwnProperty.call(data, "thinking_token_budget"))) {
      value = -1;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) continue;
    if (key === "thinking_budget" && !Number.isInteger(value)) continue;
    if (key === "top_p" && value <= 0) continue;
    values[key] = value;
  }
  return values;
}

/**
 * @param {unknown} data
 */
export function templateValues(data) {
  if (!data || typeof data !== "object") return {};
  /** @type {{ enable_thinking?: boolean, reasoning_effort?: string }} */
  const values = {};
  if (typeof data.enable_thinking === "boolean") values.enable_thinking = data.enable_thinking;
  if (data.reasoning_effort === "low" || data.reasoning_effort === "medium" || data.reasoning_effort === "high" || data.reasoning_effort === "xhigh") {
    values.reasoning_effort = data.reasoning_effort;
  }
  return values;
}

/**
 * @param {Record<string, { default: number | boolean | string | null }>} controls
 */
function fromProfile(controls) {
  /** @type {Record<string, number>} */
  const numbers = {};
  const pairs = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["topK", "top_k"],
    ["presencePenalty", "presence_penalty"],
    ["thinkingBudget", "thinking_budget"],
  ];
  for (const [from, to] of pairs) {
    const value = controls?.[from]?.default;
    if (typeof value === "number" && Number.isFinite(value)) numbers[to] = value;
  }
  /** @type {{ enable_thinking?: boolean, reasoning_effort?: string }} */
  const template = {};
  if (typeof controls?.thinking?.default === "boolean") template.enable_thinking = controls.thinking.default;
  if (typeof controls?.reasoningEffort?.default === "string" && controls.reasoningEffort.default) {
    template.reasoning_effort = controls.reasoningEffort.default;
  }
  return { numbers, template };
}

/**
 * @param {Record<string, unknown> | null} info
 */
function fromServerInfo(info) {
  /** @type {Record<string, number>} */
  const engineDefaults = {};
  let engineSource = "";
  /** @type {Record<string, number>} */
  let modelDefaults = {};
  let modelSource = "";
  /** @type {{ enable_thinking?: boolean, reasoning_effort?: string }} */
  let templateOverrides = {};
  if (!info) return { engineDefaults, engineSource, modelDefaults, modelSource, templateOverrides };
  const sampled = samplingValues(info.default_sampling_params);
  if (Object.keys(sampled).length) {
    Object.assign(engineDefaults, sampled);
    engineSource = "Live engine default_sampling_params";
  }
  const vllm = info.vllm_config;
  const modelConfig = vllm && typeof vllm === "object" ? vllm.model_config : null;
  if (modelConfig && typeof modelConfig === "object") {
    const overrides = samplingValues(modelConfig.override_generation_config);
    if (Object.keys(overrides).length) {
      Object.assign(engineDefaults, overrides);
      engineSource = "Live engine generation overrides";
    }
  }
  const reported = samplingValues(info.generation_config);
  if (Object.keys(reported).length) {
    modelDefaults = reported;
    modelSource = "Live engine model metadata";
  }
  templateOverrides = templateValues(info.default_chat_template_kwargs);
  return { engineDefaults, engineSource, modelDefaults, modelSource, templateOverrides };
}

/**
 * @param {{ baseUrl: string, apiKey?: string | null, signal?: AbortSignal }} opts
 */
async function openApiDefaults(opts) {
  const schema = await readEngineDocument(opts.baseUrl, "/openapi.json", opts);
  const properties = schema?.components?.schemas?.ChatCompletionRequest?.properties;
  if (!properties || typeof properties !== "object") return {};
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const [name, field] of Object.entries(properties)) {
    if (field && typeof field === "object" && "default" in field) defaults[name] = field.default;
  }
  return samplingValues(defaults);
}

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey?: string | null,
 *   backend?: string | null,
 *   modelId?: string | null,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function loadGenerationDefaults(opts) {
  const ctx = await readEngineContext(opts);
  let engine = ctx.backend || opts.backend || "";
  const profile = fromProfile(ctx.controls);
  let engineDefaults = {};
  let engineSource = "Not reported by the engine";
  let engineApiDefaults = {};
  let modelDefaults = {};
  let modelSource = "Not available";
  let templateOverrides = {};
  let templateDefaults = profile.template;
  let templateSource = Object.keys(profile.template).length ? "Engine info document" : "Not reported";

  const wantVllm = engine === "vllm" || engine === "";
  const wantSglang = engine === "sglang" || engine === "";
  if (wantVllm) {
    const info = await readEngineDocument(opts.baseUrl, "/server_info?config_format=json", opts);
    const live = fromServerInfo(info);
    if (Object.keys(live.engineDefaults).length || Object.keys(live.modelDefaults).length || Object.keys(live.templateOverrides).length) {
      if (!engine) engine = "vllm";
      engineDefaults = live.engineDefaults;
      engineSource = live.engineSource || engineSource;
      modelDefaults = live.modelDefaults;
      modelSource = live.modelSource || modelSource;
      templateOverrides = live.templateOverrides;
    }
    if (!Object.keys(engineDefaults).length && (engine === "vllm" || engine === "")) {
      engineApiDefaults = await openApiDefaults(opts);
      if (!engine && Object.keys(engineApiDefaults).length) engine = "vllm";
    }
  }
  if (wantSglang && engine !== "vllm") {
    const modelInfo = await readEngineDocument(opts.baseUrl, "/get_model_info", opts);
    const serverInfo = await readEngineDocument(opts.baseUrl, "/get_server_info", opts);
    const modelLive = fromServerInfo(modelInfo);
    const serverLive = fromServerInfo(serverInfo);
    if (Object.keys(serverLive.engineDefaults).length) {
      engineDefaults = serverLive.engineDefaults;
      engineSource = serverLive.engineSource;
    }
    if (Object.keys(modelLive.modelDefaults).length) {
      modelDefaults = modelLive.modelDefaults;
      modelSource = modelLive.modelSource;
    }
    const args = serverInfo?.server_args;
    const fromArgs = args && typeof args === "object" ? templateValues(args.default_chat_template_kwargs) : {};
    if (!engine && (Object.keys(serverLive.engineDefaults).length || Object.keys(modelLive.modelDefaults).length || Object.keys(fromArgs).length)) {
      engine = "sglang";
    }
    templateOverrides = { ...templateOverrides, ...serverLive.templateOverrides, ...fromArgs };
  }
  if (!Object.keys(engineDefaults).length && Object.keys(profile.numbers).length) {
    engineDefaults = profile.numbers;
    engineSource = "Engine info document";
  }

  return {
    model_id: ctx.modelId || opts.modelId || "",
    engine: engine || (Object.keys(engineDefaults).length ? engine : ""),
    engine_defaults: engineDefaults,
    engine_api_defaults: engineApiDefaults,
    engine_source: engineSource,
    model_defaults: modelDefaults,
    model_source: modelSource,
    template_defaults: templateDefaults,
    template_overrides: templateOverrides,
    template_source: templateSource,
  };
}
