import { campaignById, listCampaigns, upsertCampaign } from "./campaignStore";
import { campaignClient } from "./campaignClient";
import { runCampaign } from "./campaignRunner";

const running = new Set<string>();
const stopFlags = new Map<string, boolean>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Continue a campaign that is already marked running. A second call for the same id does nothing. */
export function kickCampaign(id: string) {
  if (running.has(id)) return;
  const current = campaignById(id);
  if (!current || current.status !== "running") return;
  running.add(id);
  void runCampaign(current, campaignClient(), {
    sleep,
    isStopped: () => stopFlags.get(id) === true,
    onUpdate: upsertCampaign,
  }).finally(() => {
    running.delete(id);
    stopFlags.delete(id);
  });
}

/**
 * Ask the campaign to stop after the current poll. The benchmark it already started keeps running.
 */
export function requestCampaignStop(id: string) {
  stopFlags.set(id, true);
  if (!running.has(id)) {
    const current = campaignById(id);
    if (current && current.status === "running") {
      upsertCampaign({ ...current, status: "stopped", completedAt: Date.now() });
    }
  }
}

export function resumeRunningCampaigns() {
  for (const run of listCampaigns()) {
    if (run.status === "running") kickCampaign(run.id);
  }
}
