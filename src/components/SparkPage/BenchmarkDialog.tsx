import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/dialogs.css";
import {
  cancelDecodeBench,
  clearDecodeBenchHistory,
  getDecodeBench,
  listDecodeBench,
  startDecodeBench,
} from "../../api/client";
import type { DecodeBenchJob, LlmBenchTarget } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BenchCopyButton } from "./BenchCopyButton";
import { BenchSwitcher, type BenchKind } from "./BenchSwitcher";
import { XIcon } from "../ui/icons";
import { buildDecodeShareCard, shareCardFileName } from "./benchShareCard";
import { HistoryTable, PageCard, PageEmpty, PageLayout } from "../bench/sparkdash/pageParts";
import { decodeHistoryRow } from "../bench/sparkdash/historyRows";
import { LiveTps } from "../bench/sparkdash/LiveTps";
import { formatDuration } from "../../shared/formatDuration";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";
import {
  DECODE_BENCH_DEFAULT_TYPE,
  DECODE_BENCH_TYPES,
  DECODE_BENCH_TYPE_META,
  decodeBenchTypeLabel,
  promptTypesOf,
  type DecodeBenchPromptType as PromptType,
} from "../../shared/llmPrompts.js";
import {
  aggregateTps,
  groupDecodeResults,
  overlapRatio,
  streamTps,
  streamWindowTitle,
  streamsDidNotOverlap,
  sumTps,
} from "./decodeRates";
import { ThroughputCompare } from "./ThroughputCompare";
import { checkDecodeComparable, compareDecodeRuns } from "./throughputCompare";

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32] as const;
const DEFAULT_SELECTED = [1, 2];
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_PROMPT_TYPE: PromptType = DECODE_BENCH_DEFAULT_TYPE;

function typeListLabel(job: DecodeBenchJob): string {
  const types = promptTypesOf(job.config);
  if (types.length) return types.map((t) => decodeBenchTypeLabel(t)).join(", ");
  return decodeBenchTypeLabel(job.config?.promptType);
}

interface BenchmarkDialogProps {
  /** Modal only; the page variant is always open. */
  open?: boolean;
  onClose?: () => void;
  /** "page" renders the same content inline (no overlay, close button or switcher). */
  variant?: "modal" | "page";
  sparkId: string;
  llmPort: number;
  modelId: string | null;
  /** Exact served request IDs; undefined for targets without model discovery. */
  models?: string[];
  remoteTarget?: LlmBenchTarget | null;
  /** Settings → Benchmark share image: the copy button also carries the card. */
  shareImage?: boolean;
  /** Unit display name for the share-card header. */
  sparkName?: string | null;
  /** Probe backend id for the share card's engine chip. */
  engine?: string | null;
  /** Probe exposure/auth posture for the share-card chip. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  /** Switch to another benchmark dialog (Decode / Prefill / Quality). Switcher hidden when omitted. */
  onSwitchBench?: (kind: BenchKind) => void;
  /** The engine's current generation tok/s (monitor reading); shown live while a run is in flight. */
  liveTps?: number | null;
}

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

/** Lock body scroll while the modal is open (important on iOS). */
function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function statusLabel(status: DecodeBenchJob["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function formatTtft(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Build a plain-text benchmark summary for the clipboard.
 * Format: "<model> | decode tok/s results:" header, then one line per
 * concurrency level with decode tok/s and key metrics.
 */
function buildShareText(job: DecodeBenchJob, modelId: string | null): string {
  const name = modelId || "unknown model";
  const typeLabel = typeListLabel(job);
  const head = `${name} | decode tok/s results (${typeLabel}):`;
  const order = promptTypesOf(job.config);
  const multi = order.length > 1;

  const lines = job.results
    .slice()
    .sort((a, b) => {
      const ta = order.indexOf((a.promptType ?? order[0]) as PromptType);
      const tb = order.indexOf((b.promptType ?? order[0]) as PromptType);
      if (ta !== tb) return ta - tb;
      return a.concurrency - b.concurrency;
    })
    .map((r) => {
      const kind = multi && r.promptType ? `${decodeBenchTypeLabel(r.promptType)} ` : "";
      if (r.totalDecodeTokens > 0 || r.totalCompletionTokens > 0) {
        return `${kind}×${r.concurrency}  ${aggregateTps(r).toFixed(1)} agg  ${sumTps(r).toFixed(1)} sum  ${streamTps(r).toFixed(1)}/str  · TTFT ${formatTtft(r.meanTtftMs)}`;
      }
      return `${kind}×${r.concurrency}  failed${r.error ? ` — ${r.error}` : ""}`;
    });

  return [head, "", ...lines].join("\n");
}

function ResultRow({ r, max }: { r: DecodeBenchJob["results"][number]; max: number }) {
  const agg = aggregateTps(r);
  const pct = max > 0 && agg > 0 ? Math.max(2, Math.round((agg / max) * 100)) : 0;
  const overlap = overlapRatio(r);
  const note = streamsDidNotOverlap(r) ? "Streams did not overlap." : null;
  const tip = [r.error, streamWindowTitle(r)].filter(Boolean).join("\n");
  return (
    <article className="bench-result-row" title={tip || undefined}>
      <div className="bench-result-row__load">
        <span className="bench-result-row__badge">×{r.concurrency}</span>
        <div className="bench-result-row__facts">
          <span>
            TTFT <strong>{formatTtft(r.meanTtftMs)}</strong>
          </span>
          <span className="bench-result-row__sep" aria-hidden>
            ·
          </span>
          <span className={r.streamsFailed ? "text-warning" : undefined}>
            <strong>
              {r.streamsOk}/{r.streamsOk + r.streamsFailed}
            </strong>{" "}
            streams
          </span>
          {overlap != null ? (
            <>
              <span className="bench-result-row__sep" aria-hidden>
                ·
              </span>
              <span>
                overlap <strong>{overlap.toFixed(2)}</strong>
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="bench-result-row__speeds bench-speeds--three">
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">Stream</span>
          <span className="bench-result-row__value">
            {streamTps(r).toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">Sum</span>
          <span className="bench-result-row__value">
            {sumTps(r).toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">Aggregate</span>
          <span className="bench-result-row__value bench-result-row__value--accent">
            {agg.toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
      </div>

      {note ? <p className="bench-result-row__note">{note}</p> : null}

      <div className="bench-result-row__bar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
    </article>
  );
}

function ResultGroups({ job, max }: { job: DecodeBenchJob; max: number }) {
  return (
    <>
      {groupDecodeResults(job).map((g) => (
        <div key={g.label ?? g.type ?? "levels"}>
          {g.label ? <div className="bench-results__caption">{g.label}</div> : null}
          {g.rows.map((r) => (
            <ResultRow key={`${r.promptType ?? g.type ?? "t"}-${r.concurrency}`} r={r} max={max} />
          ))}
        </div>
      ))}
    </>
  );
}

export function BenchmarkDialog({
  open: openProp = true,
  onClose = () => {},
  variant = "modal",
  sparkId,
  llmPort,
  modelId,
  models,
  remoteTarget = null,
  shareImage = false,
  sparkName = null,
  engine = null,
  posture = null,
  onSwitchBench,
  liveTps = null,
}: BenchmarkDialogProps) {
  const isPage = variant === "page";
  const open = isPage || openProp;
  const [history, setHistory] = useState<DecodeBenchJob[]>([]);
  const [selected, setSelected] = useState<number[]>([...DEFAULT_SELECTED]);
  const [maxTokensDraft, setMaxTokensDraft] = useState(String(DEFAULT_MAX_TOKENS));
  const [promptTypes, setPromptTypes] = useState<PromptType[]>([DEFAULT_PROMPT_TYPE]);
  const [job, setJob] = useState<DecodeBenchJob | null>(null);
  const [compareId, setCompareId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const selectionTargetRef = useRef<string | null>(null);
  const selectionTarget = JSON.stringify([sparkId, llmPort, remoteTarget?.host, remoteTarget?.port, remoteTarget?.tls]);
  const availableModels = useMemo(() => remoteTarget ? [] : [...new Set(
    (models ?? []).filter((id) => typeof id === "string" && id.trim().length > 0)
  )], [models, remoteTarget]);
  const hasModelDiscovery = !remoteTarget && models !== undefined;
  const modelSelectionValid = !hasModelDiscovery || (selectedModel !== null && availableModels.includes(selectedModel));

  useEffect(() => {
    if (!open) {
      selectionTargetRef.current = null;
      return;
    }
    const targetChanged = selectionTargetRef.current !== selectionTarget;
    selectionTargetRef.current = selectionTarget;
    if (!targetChanged && hasModelDiscovery && selectedModel && availableModels.includes(selectedModel)) return;
    const next = hasModelDiscovery
      ? (targetChanged && modelId && availableModels.includes(modelId) ? modelId : availableModels[0] ?? null)
      : remoteTarget ? null : modelId;
    if (targetChanged) setModelNotice(null);
    else if (hasModelDiscovery && selectedModel && selectedModel !== next) {
      setModelNotice(next ? `Selected model is no longer served. Switched to ${next}.` : "No models are currently served by this target.");
    } else setModelNotice(null);
    setSelectedModel(next);
  }, [open, selectionTarget, hasModelDiscovery, availableModels, modelId, remoteTarget, selectedModel]);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const isRunning = job?.status === "running";
  // A saved run belongs to the model it ran against, which may not be the one loaded now (or any).
  const resultModelId = job?.config?.modelId || job?.results?.find((r) => r.model)?.model || modelId;

  const { mounted, visible } = useModalPresence(open);

  useEscape(onClose, open && !starting && !isPage);
  useBodyScrollLock(mounted && !isPage);

  const refreshHistory = useCallback(() => {
    void listDecodeBench(sparkId, benchPort)
      .then((data) => setHistory(data.history ?? []))
      .catch(() => {
        /* history is optional */
      });
  }, [sparkId, benchPort]);

  const applyJobConfig = useCallback((j: DecodeBenchJob) => {
    if (Array.isArray(j.config?.concurrencies) && j.config.concurrencies.length > 0) {
      setSelected([...j.config.concurrencies].sort((a, b) => a - b));
    }
    if (j.config?.maxTokens != null) {
      setMaxTokensDraft(String(j.config.maxTokens));
    }
    // Last-run types are shown on results; the picker always defaults to Structured
    // for the next Run. Only a still-running job pins the picker.
    if (j.status === "running") {
      const types = promptTypesOf(j.config);
      if (types.length) setPromptTypes(types);
    } else {
      setPromptTypes([DEFAULT_PROMPT_TYPE]);
    }
  }, []);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getDecodeBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            setError(null);
            if (j.status !== "running") {
              stopPoll();
              refreshHistory();
            }
          })
          .catch((err: Error) => {
            // Server --watch / restart can drop the in-memory job for a moment.
            // Recover via list, or show a clear interrupt message instead of a bare 404.
            void listDecodeBench(sparkId, benchPort)
              .then((data) => {
                if (data.active) {
                  setJob(data.active);
                  setError(null);
                  if (data.active.benchId !== benchId) {
                    startPolling(data.active.benchId);
                  } else if (data.active.status !== "running") {
                    stopPoll();
                  }
                  return;
                }
                const finished =
                  data.history?.find((j) => j.benchId === benchId) ||
                  (data.last?.benchId === benchId ? data.last : null);
                if (finished) {
                  setJob(finished);
                  setError(null);
                  stopPoll();
                  return;
                }
                setError(
                  err.message === "Benchmark not found"
                    ? "Benchmark interrupted — server restarted during the run"
                    : err.message
                );
                stopPoll();
              })
              .catch(() => {
                setError(
                  err.message === "Benchmark not found"
                    ? "Benchmark interrupted — server restarted during the run"
                    : err.message
                );
                stopPoll();
              });
          });
      }, 800);
    },
    [sparkId, benchPort, stopPoll, refreshHistory]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      setPromptTypes([DEFAULT_PROMPT_TYPE]);
      return;
    }
    setError(null);
    setJob(null);
    let cancelled = false;
    setLoadingLast(true);
    listDecodeBench(sparkId, benchPort)
      .then((data) => {
        if (cancelled) return;
        setHistory(data.history ?? []);
        if (data.active) {
          setJob(data.active);
          applyJobConfig(data.active);
          if (data.active.status === "running") {
            startPolling(data.active.benchId);
          }
          return;
        }
        if (data.last) {
          setJob(data.last);
          applyJobConfig(data.last);
          return;
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingLast(false);
      });
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [open, sparkId, benchPort, remoteTarget?.host, remoteTarget?.tls, stopPoll, startPolling, applyJobConfig]);

  useEffect(() => () => stopPoll(), [stopPoll]);

  useEffect(
    () => () => {
      if (copyResetRef.current != null) clearTimeout(copyResetRef.current);
    },
    []
  );

  const toggleType = (id: PromptType) => {
    if (isRunning || starting) return;
    setPromptTypes((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev;
        return DECODE_BENCH_TYPES.filter((t) => t !== id && prev.includes(t));
      }
      return DECODE_BENCH_TYPES.filter((t) => t === id || prev.includes(t));
    });
  };

  const toggleConcurrency = (n: number) => {
    if (isRunning || starting) return;
    setSelected((prev) => {
      if (prev.includes(n)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== n).sort((a, b) => a - b);
      }
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const startLockRef = useRef(false);

  // Page only: a run started from the Spark page's dialog (or another tab) shows up here too.
  useEffect(() => {
    if (!isPage) return;
    const t = setInterval(() => {
      if (pollRef.current != null || startLockRef.current) return;
      void listDecodeBench(sparkId, benchPort)
        .then((data) => {
          setHistory(data.history ?? []);
          if (data.active?.status === "running" && pollRef.current == null && !startLockRef.current) {
            setJob(data.active);
            setCompareId("");
            applyJobConfig(data.active);
            startPolling(data.active.benchId);
          }
        })
        .catch(() => {
          /* next tick */
        });
    }, 5000);
    return () => clearInterval(t);
  }, [isPage, sparkId, benchPort, applyJobConfig, startPolling]);

  const handleStart = async () => {
    if (startLockRef.current) return;
    if (!modelSelectionValid) {
      setError("Select a currently served model before running the benchmark");
      return;
    }
    if (selected.length === 0) {
      setError("Select at least one concurrency level");
      return;
    }
    if (promptTypes.length === 0) {
      setError("Select at least one prompt type");
      return;
    }
    const maxTokens = parseInt(maxTokensDraft.trim(), 10);
    if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) {
      setError("Max tokens must be an integer between 64 and 2048");
      return;
    }
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    setJob(null);
    setCompareId("");
    try {
      const started = await startDecodeBench(sparkId, {
        port: benchPort,
        concurrencies: selected,
        maxTokens,
        modelId: selectedModel || undefined,
        promptTypes,
        ...(remoteTarget
          ? { host: remoteTarget.host, tls: remoteTarget.tls }
          : {}),
      });
      setJob(started);
      startPolling(started.benchId);
      if (isPage) refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job || job.status !== "running") return;
    try {
      const j = await cancelDecodeBench(sparkId, job.benchId);
      setJob(j);
      startPolling(job.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewRun = () => {
    stopPoll();
    setJob(null);
    setError(null);
    setCompareId("");
  };

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearDecodeBenchHistory(sparkId, benchPort);
      stopPoll();
      setJob(null);
      setCompareId("");
      setHistory([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleView = (id: string) => {
    const found = history.find((h) => h.benchId === id);
    if (!found || isRunning) return;
    stopPoll();
    setError(null);
    setJob(found);
    setCompareId("");
  };

  if (!mounted) return null;

  const progressPct =
    job && job.progress.totalLevels > 0
      ? Math.round(
          ((job.progress.completedLevels + (job.status === "running" ? 0.35 : 0)) /
            job.progress.totalLevels) *
            100
        )
      : 0;

  const maxAgg = job ? Math.max(0, ...job.results.map((r) => (aggregateTps(r) > 0 ? aggregateTps(r) : 0))) : 0;
  const compareJob =
    compareId && job && compareId !== job.benchId ? history.find((h) => h.benchId === compareId) ?? null : null;
  const compareCheck = compareId
    ? compareJob && job
      ? checkDecodeComparable(job, compareJob)
      : { ok: false, reason: "That run is no longer in history." }
    : null;
  const compareRows = compareJob && job && compareCheck?.ok ? compareDecodeRuns(job, compareJob) : [];
  const showConfig = (isPage || !job || job.status === "running") && !loadingLast;
  const showResults = job && job.status !== "running";

  const configNode = (
    <>
          {showConfig && (
            <section className="bench-sheet__section">
              {availableModels.length > 1 && (
                <div className="bench-field">
                  <div className="bench-field__head">
                    <label htmlFor="bench-model-select" className="bench-sheet__section-title">Model</label>
                    <p className="bench-sheet__hint">Select which model the benchmark targets.</p>
                  </div>
                  <select
                    id="bench-model-select"
                    className="bench-select"
                    value={selectedModel ?? ""}
                    disabled={isRunning || starting}
                    onChange={(e) => {
                      setSelectedModel(e.target.value);
                      setModelNotice(null);
                    }}
                  >
                    {availableModels.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </div>
              )}
              {modelNotice && availableModels.length > 0 && <p className="bench-sheet__hint" role="status">{modelNotice}</p>}
              {hasModelDiscovery && availableModels.length === 0 && (
                <p className="bench-sheet__hint" role="status">No models are currently served by this target.</p>
              )}
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Type</h3>
                  <p className="bench-sheet__hint">
                    {promptTypes.length === 1
                      ? DECODE_BENCH_TYPE_META.find((t) => t.id === promptTypes[0])?.hint
                      : "Selected types run in order, then each concurrency level."}
                    {" · temp 0, thinking off"}
                  </p>
                </div>
                <div className="bench-type-grid" role="group" aria-label="Decode benchmark types">
                  <button
                    type="button"
                    aria-pressed={promptTypes.length === DECODE_BENCH_TYPES.length}
                    title="Select structured, prose, code, and JSON"
                    disabled={isRunning || starting}
                    onClick={() => setPromptTypes([...DECODE_BENCH_TYPES])}
                    className={`bench-conc-btn${promptTypes.length === DECODE_BENCH_TYPES.length ? " is-on" : ""}`}
                  >
                    All types
                  </button>
                  {DECODE_BENCH_TYPE_META.map((t) => {
                    const on = promptTypes.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={on}
                        title={t.hint}
                        disabled={isRunning || starting}
                        onClick={() => toggleType(t.id)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Concurrency</h3>
                  <p className="bench-sheet__hint">
                    Levels run sequentially; each opens that many parallel streams.
                  </p>
                </div>
                <div className="bench-conc-grid">
                  {CONCURRENCY_OPTIONS.map((n) => {
                    const on = selected.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        disabled={isRunning || starting}
                        onClick={() => toggleConcurrency(n)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <label htmlFor="bench-max-tokens" className="bench-sheet__section-title">
                    Max tokens / stream
                  </label>
                  <p className="bench-sheet__hint">
                    Default 400 · temp 0, thinking off
                    {promptTypes.includes("structured") ? " · count 1→200" : ""}
                  </p>
                </div>
                <input
                  id="bench-max-tokens"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  disabled={isRunning || starting}
                  value={maxTokensDraft}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "" || /^\d+$/.test(raw)) setMaxTokensDraft(raw);
                  }}
                  className="bench-input"
                  size={6}
                />
              </div>
            </section>
          )}

    </>
  );
  const progressNode = (
    <>
          {job && job.status === "running" && (
            <section className="bench-sheet__section">
              <div className="bench-progress">
                <div className="bench-progress__row">
                  <span className="bench-progress__status">
                    Running
                    {job.progress.currentPromptType
                      ? ` · ${decodeBenchTypeLabel(job.progress.currentPromptType)}`
                      : ""}
                    {job.progress.currentConcurrency != null
                      ? ` · ×${job.progress.currentConcurrency}`
                      : ""}
                  </span>
                  <span className="bench-progress__meta">
                    {job.progress.completedLevels}/{job.progress.totalLevels}
                    {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div
                    className="bench-progress__fill"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
                {job.progress.message ? (
                  <p className="bench-sheet__hint">{job.progress.message}</p>
                ) : null}
              </div>
              <LiveTps tps={job.progress.liveTps ?? liveTps} active />
              {job.results.length > 0 && (
                <div className="bench-results">
                  <div className="bench-results__caption">Completed levels</div>
                  <ResultGroups job={job} max={maxAgg} />
                </div>
              )}
            </section>
          )}

    </>
  );
  const resultsNode = (
    <>
          {showResults && (
            <section className="bench-sheet__section">
              <div className="bench-status-row">
                <span
                  className={`bench-status-pill bench-status-pill--${job.status}`}
                >
                  {statusLabel(job.status)}
                </span>
                <span className="bench-status-meta">
                  {typeListLabel(job)} · {job.config.maxTokens} tok ·{" "}
                  {job.config.concurrencies.join(", ")} conc
                  {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                </span>
              </div>

              {job.error && <p className="bench-sheet__error">{job.error}</p>}

              {compareCheck ? (
                <ThroughputCompare
                  reason={compareCheck.ok ? null : compareCheck.reason}
                  rows={compareRows}
                  primaryLabel="Aggregate"
                  secondaryLabel="Stream"
                  thisLabel={job.config.modelId || "this run"}
                  otherLabel={compareJob?.config.modelId || "other run"}
                  onClear={() => setCompareId("")}
                />
              ) : null}

              {job.results.length > 0 && (
                <div className="bench-results bench-results--table">
                  <div className="bench-results__head" aria-hidden="true">
                    <span>Load</span>
                    <span className="bench-results__head-speeds bench-speeds--three">
                      <span>Stream</span>
                      <span>Sum</span>
                      <span>Aggregate</span>
                    </span>
                  </div>
                  <ResultGroups job={job} max={maxAgg} />
                </div>
              )}

              {job.results.length > 0 && (
                <p className="bench-legend">
                  <strong>Stream</strong> — mean of each stream&apos;s own tok/s, from its first token to its last.{" "}
                  <strong>Sum</strong> — that mean times the streams that produced tokens. The rates added, not a claim
                  they ran at the same instant. <strong>Aggregate</strong> — every decode token from those streams
                  divided by one shared clock, from the earliest first token to the latest last token.{" "}
                  <strong>Overlap</strong> — aggregate ÷ sum. When overlap is clearly below 1 and time-to-first-token
                  is spread out, the streams did not overlap.
                </p>
              )}
            </section>
          )}
    </>
  );

  const copyButton =
    job && job.results.length > 0 ? (
      <BenchCopyButton
        text={buildShareText(job, resultModelId)}
        buildCard={() =>
          buildDecodeShareCard(job, {
            llmPort: benchPort,
            modelId: resultModelId,
            sparkName,
            engine,
            posture,
            remoteHost: remoteTarget?.host ?? null,
          })
        }
        kind="decode"
        shareImage={shareImage}
        onError={setError}
      />
    ) : null;

  if (isPage) {
    return (
      <PageLayout
        config={
          <>
            {loadingLast && !job && <p className="bench-sheet__hint">Loading last results…</p>}
            {configNode}
          </>
        }
        runBar={
          isRunning ? (
            <button type="button" className="btn" onClick={() => void handleCancel()}>
              Cancel run
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleStart()}
              disabled={starting || selected.length === 0 || promptTypes.length === 0}
            >
              {starting ? "Starting…" : "Run benchmark"}
            </button>
          )
        }
      >
        {error && <p className="bench-sheet__error">{error}</p>}
        {isRunning && <PageCard title="Progress">{progressNode}</PageCard>}
        {showResults && (
          <PageCard
            title="Results"
            tools={
              <>
                {copyButton}
                {job.results.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => void handleClear()}
                    title="Clear saved results for this port"
                  >
                    Clear history
                  </button>
                )}
              </>
            }
          >
            {resultsNode}
          </PageCard>
        )}
        {!job && !loadingLast && (
          <PageEmpty title="No runs yet">
            Pick prompt types and concurrency levels, then run. Each type walks the selected levels. Each level
            opens that many parallel streams and reports stream, sum, and aggregate decode tok/s.
          </PageEmpty>
        )}
        {history.length > 0 && (
          <PageCard title={`History · ${history.length}`}>
            <HistoryTable
              rows={history.map(decodeHistoryRow)}
              activeId={job?.benchId ?? null}
              labelHeader="Run"
              onView={handleView}
              onCompare={showResults && job.results.length > 0 ? setCompareId : undefined}
              compareId={compareId}
              busy={isRunning || starting}
            />
          </PageCard>
        )}
      </PageLayout>
    );
  }

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      {/* Scrim — click to close when not running */}
      <button
        type="button"
        className="bench-overlay__scrim"
        aria-label="Close dialog"
        onClick={() => {
          if (!isRunning) onClose();
        }}
      />

      <div
        className="bench-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bench-title"
      >
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="bench-title" className="bench-sheet__title">
              Decode benchmark
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget
                ? formatLlmBaseUrl(remoteTarget)
                : `Port ${llmPort}`}
              {resultModelId ? ` · ${resultModelId}` : ""}
            </p>
          </div>
          <BenchSwitcher active="decode" onSwitch={onSwitchBench} disabled={isRunning || starting} />
          <button
            type="button"
            className="bench-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && (
            <p className="bench-sheet__hint">Loading last results…</p>
          )}

          {configNode}

          {error && <p className="bench-sheet__error">{error}</p>}

          {progressNode}

          {resultsNode}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
              Cancel
            </button>
          ) : job ? (
            <>
              {job.results.length > 0 && (
                <button
                  type="button"
                  className="bench-btn bench-btn--ghost"
                  onClick={() => void handleClear()}
                  title="Clear saved results for this port"
                >
                  Clear
                </button>
              )}
              {job.results.length > 0 && (
                <BenchCopyButton
                  text={buildShareText(job, resultModelId)}
                  buildCard={() =>
                    buildDecodeShareCard(job, {
                      llmPort: benchPort,
                      modelId: resultModelId,
                      sparkName,
                      engine,
                      posture,
                      remoteHost: remoteTarget?.host ?? null,
                    })
                  }
                  kind="decode"
                  shareImage={shareImage}
                  onError={setError}
                />
              )}
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                Done
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={handleNewRun}>
                Run again
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || selected.length === 0 || promptTypes.length === 0 || !modelSelectionValid}
              >
                {starting ? "Starting…" : "Run benchmark"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
