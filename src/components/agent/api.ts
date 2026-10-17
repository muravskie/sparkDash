import { authHeaders, getToken, reportAuthRequired } from "../../api/authToken";

export interface AgentStatus {
  present: boolean;
  sparkId: string | null;
  sparkName: string | null;
  healthy: boolean;
  version: string | null;
  error: string | null;
  proxyPort: number | null;
}

export function agentFrameSrc(
  proxyPort: number | null,
  here: { protocol: string; hostname: string } = location
): string | null {
  if (!Number.isInteger(proxyPort) || proxyPort == null || proxyPort < 1 || proxyPort > 65535) return null;
  if (here.protocol !== "http:" && here.protocol !== "https:") return null;
  const hostname = here.hostname;
  if (!hostname || /[/\s\\]/.test(hostname)) return null;
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const base = `${here.protocol}//${host}:${proxyPort}/`;
  const token = getToken();
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

export async function fetchAgentStatus(): Promise<AgentStatus> {
  const res = await fetch("/api/agent", { headers: { ...authHeaders() } });
  if (res.status === 401) {
    reportAuthRequired();
    throw new Error("Authentication required");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AgentStatus;
}
