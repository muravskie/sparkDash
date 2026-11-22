import { useSyncExternalStore } from "react";
import { dedupeCampaigns, type CampaignRun } from "./campaign";

const STORAGE_KEY = "sparkdash.bench.campaigns";
const MAX_RUNS = 30;

let trimmed = false;
let runs: CampaignRun[] = load();
if (trimmed) save();
const listeners = new Set<() => void>();

function load(): CampaignRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const parsedRuns = parsed.filter(isRun);
    const next = dedupeCampaigns(parsedRuns).slice(0, MAX_RUNS);
    trimmed = next.length !== parsedRuns.length;
    return next;
  } catch {
    return [];
  }
}

function isRun(value: unknown): value is CampaignRun {
  if (!value || typeof value !== "object") return false;
  const run = value as CampaignRun;
  return typeof run.id === "string" && typeof run.sparkId === "string" && run.config != null && run.headlines != null;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch {
    /* private mode */
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export function listCampaigns(): CampaignRun[] {
  return runs;
}

export function campaignById(id: string): CampaignRun | null {
  return runs.find((run) => run.id === id) ?? null;
}

export function upsertCampaign(run: CampaignRun) {
  const rest = runs.filter((item) => item.id !== run.id && !(run.jobs.decode && item.jobs.decode === run.jobs.decode));
  runs = [run, ...rest].slice(0, MAX_RUNS);
  save();
  emit();
}

export function subscribeCampaigns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCampaigns(): CampaignRun[] {
  return useSyncExternalStore(subscribeCampaigns, listCampaigns, listCampaigns);
}
