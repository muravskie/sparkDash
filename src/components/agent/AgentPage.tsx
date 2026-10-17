import { useEffect, useState } from "react";
import { agentFrameSrc, fetchAgentStatus, type AgentStatus } from "./api";
import "../../styles/agent.css";

export function AgentPage() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await fetchAgentStatus();
        if (!stop) {
          setStatus(next);
          setError("");
        }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err));
      }
      if (!stop) timer = window.setTimeout(() => void tick(), 5000);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);

  const frame = status?.present && status.healthy ? agentFrameSrc(status.proxyPort) : null;
  return (
    <div className="agent">
      <header className="page-head">
        <div>
          <h1>Agent</h1>
          <p className="page-head__sub">OpenCode through this dashboard.</p>
        </div>
      </header>
      {error ? (
        <p className="agent-error" role="alert">{error}</p>
      ) : null}
      {!status && !error ? <p className="agent-note">Checking OpenCode…</p> : null}
      {status && !status.present ? (
        <section className="panel agent-empty">
          <h2>OpenCode is not configured</h2>
          <p>The server reaches OpenCode on its loopback upstream when a credentials file is set. A fleet unit named uba is not required. This page does not guess a host.</p>
        </section>
      ) : null}
      {status?.present && !status.healthy ? (
        <section className="panel agent-empty">
          <h2>OpenCode is unavailable</h2>
          <p>{status.error || "OpenCode is not responding."}</p>
        </section>
      ) : null}
      {frame ? (
        <iframe className="agent-frame" title="OpenCode" src={frame} referrerPolicy="no-referrer" />
      ) : null}
    </div>
  );
}
