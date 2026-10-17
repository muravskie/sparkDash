import { useCallback, useEffect, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { SparkChips } from "../bench/SparkChips";
import { useBenchSpark } from "../bench/useBenchSpark";
import { acknowledgeOperation, fetchModels, postModelAction, type ControllerModel, type ModelsBoard } from "./api";
import "../../styles/models.css";

function isExternal(model: ControllerModel): boolean {
  return !model.registered || model.ownership === "external" || model.ownership === "external-monitor";
}

function ModelsBoardView({ spark }: { spark: SparkSnapshot }) {
  const [board, setBoard] = useState<ModelsBoard | null>(null);
  const [error, setError] = useState("");
  const [proposed, setProposed] = useState<{ model: ControllerModel; action: "activate" | "deactivate" } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchModels(spark.id);
      setBoard(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [spark.id]);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      if (!stop) await load();
      if (!stop) timer = window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function confirm() {
    if (!proposed || submitting || board?.active) return;
    const { model, action } = proposed;
    setSubmitting(true);
    setError("");
    try {
      await postModelAction(spark.id, model.id, action);
      setProposed(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function acknowledge(id: string) {
    setError("");
    try {
      await acknowledgeOperation(spark.id, id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!board) {
    return <p className="mdls-note">{error || "Reading the model controller…"}</p>;
  }
  if (!board.configured) {
    return (
      <section className="panel mdls-empty">
        <h2>No model controller</h2>
        <p>
          {spark.name} has no model controller this dashboard can reach. This page does not start or stop models.
        </p>
      </section>
    );
  }

  const active = board.active;
  return (
    <div className="mdls-stack">
      {error ? <p className="mdls-error" role="alert">{error}</p> : null}
      {board.error ? <p className="mdls-error" role="alert">{board.error}</p> : null}
      <section className="panel">
        <header className="mdls-head">
          <h2>Model registry and monitors</h2>
          <span>{board.models.length} observed</span>
        </header>
        <div className="mdls-scroll">
          <table className="mdls-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Endpoint</th>
                <th>Roles</th>
                <th>Engine</th>
                <th>Ownership</th>
                <th>Runtime</th>
                <th>Health</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {board.models.map((model) => {
                const external = isExternal(model);
                const blocked = !board.available || Boolean(active) || submitting || external;
                return (
                  <tr key={model.id}>
                    <td>
                      <strong>{model.name}</strong>
                      <span className="mdls-detail">{model.registered ? "Controller registry" : "Explicit external monitor"}</span>
                    </td>
                    <td className="mono">{model.endpoint || "No endpoint"}</td>
                    <td>{model.roles.length ? model.roles.join(", ") : "No roles"}</td>
                    <td>{model.engine || "Unconfigured"}</td>
                    <td>{model.ownership || "None observed"}</td>
                    <td>{model.runtime}</td>
                    <td>
                      <span className={`mdls-health mdls-health--${model.health.status}`} title={model.health.reason || undefined}>
                        {model.health.label}
                      </span>
                    </td>
                    <td>
                      {external ? (
                        <span className="mdls-detail">External · monitoring only</span>
                      ) : (
                        <div className="mdls-actions">
                          <button
                            type="button"
                            disabled={blocked || model.enabled === false || model.runtime === "running"}
                            onClick={() => {
                              setProposed({ model, action: "activate" });
                              setError("");
                            }}
                          >
                            Activate
                          </button>
                          <button
                            type="button"
                            disabled={blocked || model.ownership !== "managed" || model.runtime !== "running"}
                            onClick={() => {
                              setProposed({ model, action: "deactivate" });
                              setError("");
                            }}
                          >
                            Deactivate
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {proposed ? (
        <section className="panel" aria-label="Confirm model action">
          <h2>{proposed.action === "activate" ? "Activate" : "Deactivate"} {proposed.model.name}?</h2>
          <p>
            {proposed.action === "activate"
              ? "The controller will activate this model and stop any conflicting managed workloads. External ownership conflicts will be reported."
              : "The controller will stop this managed workload."}
          </p>
          <div className="mdls-actions">
            <button type="button" onClick={() => void confirm()} disabled={submitting || Boolean(active)}>
              {submitting ? "Submitting…" : `Confirm ${proposed.action}`}
            </button>
            <button type="button" onClick={() => setProposed(null)} disabled={submitting}>Cancel</button>
          </div>
        </section>
      ) : null}
      {board.operations.length ? (
        <section className="panel">
          <header className="mdls-head"><h2>Dashboard operations</h2></header>
          {board.operations.slice(0, 10).map((operation) => (
            <div key={operation.id} className="mdls-op">
              <strong>{operation.action} · {operation.model_id}</strong>
              <span className={operation.state === "failed" || operation.state === "unknown" ? "mdls-error" : undefined}>
                {operation.state === "working" ? "Controller working…" : operation.state}
              </span>
              {operation.result?.transaction_id ? (
                <span className="mdls-detail mono">{operation.result.status} · Transaction {operation.result.transaction_id}</span>
              ) : null}
              {operation.error ? <p className="mdls-error">{operation.error}</p> : null}
              {operation.state === "unknown" && !operation.acknowledged ? (
                <>
                  <p className="mdls-detail">Review current model status and controller transactions before acknowledging this unresolved result.</p>
                  <button type="button" onClick={() => void acknowledge(operation.id)}>Acknowledge after review</button>
                </>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {board.events.length ? (
        <section className="panel">
          <header className="mdls-head">
            <h2>Recent controller activity</h2>
            <span>Observed journal events</span>
          </header>
          {board.events.slice(-8).reverse().map((event, index) => (
            <div key={`${event.transaction_id || "event"}-${index}`} className="mdls-op">
              <strong>{event.model_id || "Unknown model"} · {event.operation || "unknown"}</strong>
              <span>{event.phase || "unknown phase"}</span>
              <span className="mdls-detail mono">{event.transaction_id || "No transaction id"}</span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/** Controller lifecycle for the Spark selected on the benchmark pages. */
export function ModelsPage({ sparks }: { sparks: readonly SparkSnapshot[] }) {
  const { spark, select, eligible } = useBenchSpark(sparks);
  return (
    <div className="mdls">
      <header className="page-head">
        <div>
          <h1>Models</h1>
          <p className="page-head__sub">
            Activate and deactivate models through the controller on the selected Spark. External workloads are monitored only.
          </p>
        </div>
      </header>
      <SparkChips sparks={eligible} activeId={spark?.id ?? null} onSelect={select} ariaLabel="Spark" />
      {spark ? <ModelsBoardView key={spark.id} spark={spark} /> : <p className="mdls-note">No Spark registered.</p>}
    </div>
  );
}
