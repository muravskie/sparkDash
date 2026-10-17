/** Phases that close a controller transaction. Matches model-controller recovery. */
export const TERMINAL_PHASES = new Set([
  "committed",
  "rejected",
  "rolled-back",
  "recovered-commit",
  "recovered-rollback",
]);

/**
 * @param {string | null | undefined} endpoint
 * @returns {number | null}
 */
export function endpointPort(endpoint) {
  if (typeof endpoint !== "string" || !endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (!url.port) return null;
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * @param {boolean | null | undefined} healthy
 */
export function healthOf(healthy) {
  if (healthy === true) return { status: "healthy", label: "Healthy", reason: null };
  if (healthy === false) return { status: "unhealthy", label: "Unhealthy", reason: null };
  return { status: "unknown", label: "Not checked", reason: null };
}

/**
 * @param {unknown} probes
 * @param {number | null} port
 */
function engineFromProbe(probes, port) {
  if (!port || !Array.isArray(probes)) return null;
  const row = probes.find((probe) => Number(probe?.port) === port);
  return typeof row?.backend === "string" && row.backend ? row.backend : null;
}

/**
 * Registry rows from the controller, plus configured LLM probes the registry
 * does not list. A probe is explicit: the Spark's llmPorts are the endpoints
 * sparkDash was told to watch. Those rows are monitoring only.
 *
 * @param {object | null | undefined} status
 * @param {unknown[]} [probes]
 * @param {string} [host]
 */
export function shapeModels(status, probes = [], host = "") {
  const raw = Array.isArray(status?.models) ? status.models : [];
  const rows = [];
  const registryPorts = new Set();
  const registryIds = new Set();
  for (const model of raw) {
    if (!model || typeof model.id !== "string" || !model.id) continue;
    const endpoint = typeof model.inference_endpoint === "string"
      ? model.inference_endpoint
      : typeof model.endpoint === "string"
        ? model.endpoint
        : null;
    const port = endpointPort(endpoint);
    if (port) registryPorts.add(port);
    registryIds.add(model.id);
    rows.push({
      id: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      endpoint,
      roles: Array.isArray(model.roles) ? model.roles.filter((role) => typeof role === "string") : [],
      engine: typeof model.engine === "string" && model.engine ? model.engine : engineFromProbe(probes, port),
      ownership: typeof model.ownership === "string" ? model.ownership : null,
      runtime: typeof model.runtime === "string" && model.runtime ? model.runtime : "absent",
      health: healthOf(model.healthy),
      registered: model.registered !== false,
      enabled: model.enabled !== false,
    });
  }
  if (!Array.isArray(probes)) return rows;
  for (const probe of probes) {
    const port = Number(probe?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (registryPorts.has(port)) continue;
    if (!probe?.available || typeof probe.modelId !== "string" || !probe.modelId) continue;
    if (registryIds.has(probe.modelId)) continue;
    const id = `external:${port}`;
    if (rows.some((row) => row.id === id)) continue;
    rows.push({
      id,
      name: probe.modelId,
      endpoint: host ? `http://${host}:${port}/v1` : null,
      roles: ["text-generation"],
      engine: typeof probe.backend === "string" && probe.backend ? probe.backend : null,
      ownership: "external-monitor",
      runtime: "unknown",
      health: healthOf(true),
      registered: false,
      enabled: null,
    });
  }
  return rows;
}

/**
 * @param {unknown[]} events
 * @returns {boolean}
 */
export function hasUnfinishedTransaction(events) {
  const latest = new Map();
  if (!Array.isArray(events)) return false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const id = event.transaction_id;
    if (typeof id !== "string" || !id) continue;
    latest.set(id, event);
  }
  for (const event of latest.values()) {
    if (!TERMINAL_PHASES.has(event.phase)) return true;
  }
  return false;
}
