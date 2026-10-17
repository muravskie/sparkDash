/**
 * Find the fleet unit named uba. Matching uses the live registry shape
 * (name, SSH host) and, when a monitor snapshot is present, that unit's
 * Tailscale hostname. No address is invented when nothing matches.
 */

/**
 * @param {unknown} value
 */
function hostLabel(value) {
  let raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  raw = raw.split("/")[0].replace(/\.$/, "");
  if (raw.startsWith("[") && raw.includes("]")) raw = raw.slice(1, raw.indexOf("]"));
  else if (raw.includes(":") && !raw.includes("::")) raw = raw.split(":")[0];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw;
  if (raw.endsWith(".local")) raw = raw.slice(0, -".local".length);
  return raw.split(".")[0];
}

/**
 * @param {unknown} value
 */
function isUba(value) {
  return hostLabel(value) === "uba";
}

/**
 * @param {object | null | undefined} spark
 * @param {object | null | undefined} snapshot
 * @returns {number}
 */
function rank(spark, snapshot) {
  if (isUba(spark?.name)) return 1;
  if (isUba(spark?.ssh?.host)) return 2;
  const tailscale = snapshot?.metrics?.tailscale;
  if (isUba(tailscale?.hostName) || isUba(tailscale?.dnsName)) return 3;
  if (isUba(snapshot?.name)) return 4;
  return 0;
}

/**
 * @param {object[] | null | undefined} sparks
 * @param {object[] | null | undefined} [snapshots]
 */
export function findUbaSpark(sparks, snapshots = []) {
  const byId = new Map();
  for (const snapshot of snapshots || []) {
    if (snapshot?.id) byId.set(snapshot.id, snapshot);
  }
  let best = null;
  let bestRank = 0;
  for (const spark of sparks || []) {
    const next = rank(spark, byId.get(spark?.id));
    if (next && (bestRank === 0 || next < bestRank)) {
      best = spark;
      bestRank = next;
    }
  }
  return best;
}

export const EMPTY_AGENT_STATUS = {
  present: false,
  sparkId: null,
  sparkName: null,
  healthy: false,
  version: null,
  error: null,
  proxyPort: null,
};
