import type { CampaignRun, CampaignStage } from "./campaign";
import { CAMPAIGN_STAGES, headlinesFromJobs } from "./campaign";

export type BusyBench = "decode" | "prefill" | "quality" | "tool-eval" | "install";

export interface StagePoll {
  status: string;
  error?: string | null;
}

/** The child-bench calls a campaign is allowed to make. There is no cancel. */
export interface CampaignClient {
  /** A bench already running on this Spark, ignoring ids that belong to this campaign. */
  busy(sparkId: string, ownJobIds: string[]): Promise<BusyBench | null>;
  startDecode(run: CampaignRun): Promise<string>;
  pollDecode(run: CampaignRun, id: string): Promise<StagePoll & { job: unknown }>;
  startPrefill(run: CampaignRun): Promise<string>;
  pollPrefill(run: CampaignRun, id: string): Promise<StagePoll & { job: unknown }>;
  startQuality(run: CampaignRun): Promise<string>;
  pollQuality(run: CampaignRun, id: string): Promise<StagePoll & { job: unknown }>;
  startToolEval(run: CampaignRun): Promise<string>;
  pollToolEval(run: CampaignRun, id: string): Promise<StagePoll & { job: unknown }>;
}

const JOB_KEY: Record<CampaignStage, keyof CampaignRun["jobs"]> = {
  decode: "decode",
  prefill: "prefill",
  quality: "quality",
  "tool-eval": "toolEval",
};

function doneStatus(status: string): "completed" | "failed" | "running" {
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "failed";
}

/**
 * Walk decode, prefill, quality, then tool-eval. A bench that is already running blocks the
 * start. Stop, failure, and a lost poll leave that bench running: this function never cancels one.
 */
export async function runCampaign(
  initial: CampaignRun,
  client: CampaignClient,
  hooks: {
    sleep: (ms: number) => Promise<void>;
    pollMs?: number;
    isStopped: () => boolean;
    onUpdate: (run: CampaignRun) => void;
  },
): Promise<CampaignRun> {
  let run = initial;
  const publish = (next: CampaignRun) => {
    run = next;
    hooks.onUpdate(next);
  };
  const pollMs = hooks.pollMs ?? 2000;
  const finish = (status: CampaignRun["status"], error: string | null, headlines = run.headlines): CampaignRun => {
    const next = { ...run, status, error, headlines, completedAt: Date.now() };
    publish(next);
    return next;
  };
  if (hooks.isStopped()) return finish("stopped", null);

  const own = Object.values(run.jobs).filter((id): id is string => Boolean(id));
  const busy = await client.busy(run.sparkId, own);
  if (busy) return finish("failed", `busy:${busy}`);
  if (hooks.isStopped()) return finish("stopped", null);

  const jobs: Parameters<typeof headlinesFromJobs>[0] = {};

  for (const stage of CAMPAIGN_STAGES) {
    if (hooks.isStopped()) return finish("stopped", null, headlinesFromJobs(jobs));
    const key = JOB_KEY[stage];
    publish({ ...run, stage, error: null });
    let id = run.jobs[key];
    try {
      if (!id) {
        id = await startStage(client, stage, run);
        publish({ ...run, stage, jobs: { ...run.jobs, [key]: id } });
      }
      const polled = await waitStage(client, stage, run, id, hooks.sleep, pollMs, hooks.isStopped);
      if (polled.stopped) return finish("stopped", null, headlinesFromJobs(jobs));
      assignJob(jobs, stage, polled.job);
      if (polled.status !== "completed") {
        return finish("failed", polled.error || stage, headlinesFromJobs(jobs));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finish("failed", message, headlinesFromJobs(jobs));
    }
  }
  return finish("completed", null, headlinesFromJobs(jobs));
}

function assignJob(jobs: Parameters<typeof headlinesFromJobs>[0], stage: CampaignStage, job: unknown) {
  if (stage === "decode") jobs.decode = job as Parameters<typeof headlinesFromJobs>[0]["decode"];
  else if (stage === "prefill") jobs.prefill = job as Parameters<typeof headlinesFromJobs>[0]["prefill"];
  else if (stage === "quality") jobs.quality = job as Parameters<typeof headlinesFromJobs>[0]["quality"];
  else jobs.tool = job as Parameters<typeof headlinesFromJobs>[0]["tool"];
}

async function startStage(client: CampaignClient, stage: CampaignStage, run: CampaignRun): Promise<string> {
  if (stage === "decode") return client.startDecode(run);
  if (stage === "prefill") return client.startPrefill(run);
  if (stage === "quality") return client.startQuality(run);
  return client.startToolEval(run);
}

async function waitStage(
  client: CampaignClient,
  stage: CampaignStage,
  run: CampaignRun,
  id: string,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  isStopped: () => boolean,
): Promise<{ status: "completed" | "failed" | "running"; error: string | null; job: unknown; stopped: boolean }> {
  let misses = 0;
  for (;;) {
    if (isStopped()) return { status: "running", error: null, job: null, stopped: true };
    let polled: StagePoll & { job: unknown };
    try {
      polled = await pollStage(client, stage, run, id);
      misses = 0;
    } catch (err) {
      misses += 1;
      if (misses >= 5) throw err;
      await sleep(pollMs);
      continue;
    }
    const status = doneStatus(polled.status);
    if (status !== "running") return { status, error: polled.error ?? null, job: polled.job, stopped: false };
    await sleep(pollMs);
  }
}

function pollStage(client: CampaignClient, stage: CampaignStage, run: CampaignRun, id: string) {
  if (stage === "decode") return client.pollDecode(run, id);
  if (stage === "prefill") return client.pollPrefill(run, id);
  if (stage === "quality") return client.pollQuality(run, id);
  return client.pollToolEval(run, id);
}
