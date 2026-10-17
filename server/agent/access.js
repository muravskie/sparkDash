import { allowOpenRemote, authenticate, configuredToken, requireRemoteAuth, AGENT_PROXY_COOKIE } from "../auth.js";

/**
 * Same gate as the dashboard API. Loopback reads stay open when no token is
 * configured. A remote client without the dashboard session is rejected.
 * WebSocket upgrades also require the token on loopback, matching `/ws`.
 *
 * @param {import("express").Request | import("http").IncomingMessage} req
 * @param {{ upgrade?: boolean }} [opts]
 * @returns {{ status: number, error: string } | null}
 */
export function agentDenied(req, opts = {}) {
  const method = (req.method || "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const remote = requireRemoteAuth(process.env.BIND_HOST || "127.0.0.1");
  if (!mutating && !remote && !(opts.upgrade && configuredToken())) return null;
  if (!mutating && remote && !configuredToken()) {
    if (allowOpenRemote()) return null;
    return { status: 403, error: "Remote access requires SPARKDASH_TOKEN" };
  }
  const result = authenticate(req, opts);
  if (!result.ok) return { status: result.status || 401, error: result.error || "Authentication required" };
  return null;
}

export { AGENT_PROXY_COOKIE };
