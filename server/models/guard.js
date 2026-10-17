import { endpointPort } from "./shape.js";

/** Compare launcher names and model ids without punctuation or case. */
export function normalizeWorkloadName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function directoryName(dir) {
  if (typeof dir !== "string" || !dir) return "";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/**
 * A launcher and a controller model are the same workload when their ports
 * match, or when neither side disagrees on port and the launcher name or
 * folder matches the model id or name.
 *
 * @param {{ name?: string, dir?: string, port?: number | null }} launcher
 * @param {{ id?: string, name?: string, endpoint?: string | null }} model
 */
export function launcherMatchesModel(launcher, model) {
  const modelPort = endpointPort(model?.endpoint);
  const launcherPort = Number.isInteger(launcher?.port) ? launcher.port : null;
  if (launcherPort && modelPort && launcherPort === modelPort) return true;
  if (launcherPort && modelPort && launcherPort !== modelPort) return false;
  const modelNames = [model?.id, model?.name].map(normalizeWorkloadName).filter(Boolean);
  const launcherNames = [launcher?.name, directoryName(launcher?.dir)].map(normalizeWorkloadName).filter(Boolean);
  if (!modelNames.length || !launcherNames.length) return false;
  return modelNames.some((name) => launcherNames.includes(name));
}

/**
 * @param {unknown[]} models
 */
export function runningManaged(models) {
  return (Array.isArray(models) ? models : []).filter(
    (model) => model && model.registered !== false && model.ownership === "managed" && model.runtime === "running"
  );
}

/**
 * When a managed model is running, hide start/stop for the matching script.
 * If a running managed model matches no launcher, hide start/stop for the
 * whole list so the script panel cannot start a second copy.
 *
 * @param {Array<{ id: string, name?: string, dir?: string, port?: number | null }>} launchers
 * @param {unknown[]} models
 */
export function scriptGuard(launchers, models) {
  const list = Array.isArray(launchers) ? launchers : [];
  const managed = runningManaged(models);
  if (!managed.length) return { hideAll: false, blockedIds: [], reason: null };
  const blocked = new Set();
  const unmatched = [];
  for (const model of managed) {
    const hits = list.filter((launcher) => launcherMatchesModel(launcher, model));
    if (!hits.length) unmatched.push(model.name || model.id);
    else for (const hit of hits) blocked.add(hit.id);
  }
  if (unmatched.length) {
    return {
      hideAll: true,
      blockedIds: list.map((launcher) => launcher.id),
      reason: `The controller is running ${unmatched.join(", ")}. That workload cannot be matched to a script folder by port or by name, so start and stop are hidden for every script on this Spark while a managed model is running.`,
    };
  }
  return {
    hideAll: false,
    blockedIds: [...blocked],
    reason: "The model controller is running this workload, so start and stop for it stay on the Models page.",
  };
}
