import type { ChatUsage } from "./lit/types";

export interface ModelPrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : null;
}

function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function detail(usage: ChatUsage, key: string): number {
  const details = usage.prompt_tokens_details;
  if (!details || typeof details !== "object") return 0;
  return tokens((details as Record<string, unknown>)[key]) ?? 0;
}

/**
 * Dollars for one reply from reported tokens and the catalog's per-1M rates.
 * Free models and replies with no usage return null. Cached input is billed
 * at cache_read when the response reports it; the rest of the prompt is input.
 */
export function turnCostUsd(usage: ChatUsage | undefined, price: ModelPrice | null | undefined): number | null {
  if (!price) return null;
  const input = rate(price.input);
  const output = rate(price.output);
  const cacheRead = rate(price.cache_read);
  const cacheWrite = rate(price.cache_write);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  if (!usage) return null;
  const prompt = tokens(usage.prompt_tokens);
  const completion = tokens(usage.completion_tokens);
  if (prompt == null && completion == null) return null;
  const promptN = prompt ?? 0;
  let cached = detail(usage, "cached_tokens") || tokens(usage.cache_read_input_tokens) || 0;
  let written = detail(usage, "cache_write_tokens") || tokens(usage.cache_creation_input_tokens) || 0;
  if (cached + written > promptN) {
    cached = Math.min(cached, promptN);
    written = Math.min(written, Math.max(0, promptN - cached));
  }
  const fresh = Math.max(0, promptN - cached - written);
  return (fresh * input + cached * cacheRead + written * cacheWrite + (completion ?? 0) * output) / 1_000_000;
}

/** Compact dollar text for the end of the reply status line. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value === 0) return "$0.00";
  if (value >= 0.01) return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const digits = value >= 0.0001 ? 4 : 6;
  const text = value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}
