import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";
import { BenchTargetFrame, type BenchTargetProps } from "../sparkdash/BenchTargetFrame";
import { PageCard, PageEmpty, PageLayout } from "../sparkdash/pageParts";
import {
  CAMPAIGN_CONCURRENCIES,
  CAMPAIGN_DECODE_CONTEXTS,
  CAMPAIGN_LONG_SIZES,
  CAMPAIGN_PREFILL_SIZES,
  CAMPAIGN_PROMPT_TYPES,
  CAMPAIGN_STAGES,
  asCustom,
  campaignDiffs,
  campaignEngine,
  campaignTitle,
  campaignsComparable,
  createCampaign,
  engineLabel,
  registryEngine,
  fullSweepConfig,
  type CampaignConfig,
  type CampaignDiffField,
  type CampaignRun,
  type CampaignStage,
  type CampaignView,
  type ToolEvalTemplate,
} from "./campaign";
import { CampaignCompare, CampaignReport } from "./campaignReport";
import { remoteOf } from "./campaignClient";
import { kickCampaign, requestCampaignStop, resumeRunningCampaigns } from "./campaignSession";
import { listDecodeBench, listPrefillBench, listQualityBench, fetchToolEvalRuns } from "../../../api/client";
import { fetchModels } from "../../models/api";
import { adoptFinishedCampaign } from "./campaignAdopt";
import { listCampaigns, upsertCampaign, useCampaigns } from "./campaignStore";

const TOOL_TEMPLATES: ToolEvalTemplate[] = ["short", "regular", "regular-hard", "hard"];

function num(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function toggleNumber(list: number[], value: number): number[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return next.sort((a, b) => a - b);
}

export function CampaignPage({ spark, benchShareImage = false }: { spark: SparkSnapshot | null; benchShareImage?: boolean }) {
  return (
    <BenchTargetFrame spark={spark} benchShareImage={benchShareImage}>
      {(target) => <CampaignBody target={target} />}
    </BenchTargetFrame>
  );
}

function CampaignBody({ target }: { target: BenchTargetProps }) {
  const { t } = useTranslation("benchmarks");
  const runs = useCampaigns();
  const [config, setConfig] = useState<CampaignConfig>(() => fullSweepConfig());
  const [pickA, setPickA] = useState("");
  const [pickB, setPickB] = useState("");
  const [focusId, setFocusId] = useState("");
  const [view, setView] = useState<CampaignView>("headline");
  const [waitingForTool, setWaitingForTool] = useState(false);

  useEffect(() => {
    resumeRunningCampaigns();
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const [decode, prefill, quality, tool] = await Promise.all([
          listDecodeBench(target.sparkId),
          listPrefillBench(target.sparkId),
          listQualityBench(target.sparkId),
          fetchToolEvalRuns(target.sparkId),
        ]);
        if (stop) return;
        const adopted = adoptFinishedCampaign(target.sparkId, {
          decode: decode.active ? [decode.active, ...decode.history] : decode.history,
          prefill: prefill.active ? [prefill.active, ...prefill.history] : prefill.history,
          quality: quality.active ? [quality.active, ...quality.history] : quality.history,
          tool: tool.runs,
        });
        const jobs = quality.active ? [quality.active, ...quality.history] : quality.history;
        for (const run of listCampaigns()) {
          if (run.sparkId !== target.sparkId) continue;
          const record = jobs.find((job) => job.benchId === run.jobs.quality)?.engine?.record;
          const engine = campaignEngine(run.engine, record);
          if (engine && engine !== run.engine) upsertCampaign({ ...run, engine });
        }
        if (adopted.kind === "ready") {
          const decodeId = adopted.run.jobs.decode;
          const already = listCampaigns().some((run) => run.id === adopted.run.id || (decodeId != null && run.jobs.decode === decodeId));
          if (!already) upsertCampaign(adopted.run);
          setWaitingForTool(false);
          return;
        }
        setWaitingForTool(adopted.kind === "waiting");
      } catch {
        /* the history stays as it was */
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 10000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [target.sparkId]);

  const mine = runs.filter((run) => run.sparkId === target.sparkId);
  const active = mine.find((run) => run.status === "running") ?? null;
  const invalid = !configValid(config);

  const edit = (next: CampaignConfig) => setConfig(asCustom(next));
  const focused = mine.find((run) => run.id === focusId) ?? mine.find((run) => run.status === "completed") ?? mine[0] ?? null;

  const start = () => {
    if (active || invalid) return;
    const remote = remoteOf(target.remoteTarget);
    const port = remote.port ?? target.llmPort;
    const fallback = engineLabel(target.engine, target.engineVersion);
    void fetchModels(target.sparkId)
      .then((board) => registryEngine(board.models, port) || fallback)
      .catch(() => fallback)
      .then((engine) => {
        const run = createCampaign({
          sparkId: target.sparkId,
          port,
          modelId: target.modelId,
          engine,
          host: remote.host,
          tls: remote.tls,
          config,
        });
        upsertCampaign(run);
        kickCampaign(run.id);
      });
  };

  const runA = runs.find((run) => run.id === pickA) ?? null;
  const runB = runs.find((run) => run.id === pickB) ?? null;
  const diffs = runA && runB ? campaignDiffs(runA.config, runB.config) : [];
  const paired = runA && runB ? campaignsComparable(runA.config, runB.config) : false;

  return (
    <PageLayout
      config={
        <div className="campaign-config">
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.presets")}>
            <button type="button" className={`bench-conc-btn${config.preset === "full" ? " is-on" : ""}`} aria-pressed={config.preset === "full"} onClick={() => setConfig(fullSweepConfig())}>{t("campaign.fullSweep")}</button>
          </div>
          <p className="bench-sheet__hint">{config.preset === "custom" ? t("campaign.custom") : t("campaign.fullSweepHelp")}</p>

          <h3 className="bench-sheet__section-title">{t("campaign.stage.decode")}</h3>
          <label className="qrun__check">
            <input type="checkbox" checked={config.decode.thinking} onChange={(e) => edit({ ...config, decode: { ...config.decode, thinking: e.target.checked } })} />
            <span>{t("campaign.thinking")}</span>
          </label>
          <div className="bp-field">
            <span className="eyebrow">{t("campaign.temperature")}</span>
            <input className="bench-input" type="number" min={0} max={2} step={0.1} value={config.decode.temperature}
              onChange={(e) => edit({ ...config, decode: { ...config.decode, temperature: Number(e.target.value) } })} />
          </div>
          <div className="bp-field">
            <span className="eyebrow">{t("campaign.maxTokens")}</span>
            <input className="bench-input" type="number" min={64} max={2048} step={1} value={config.decode.maxTokens}
              onChange={(e) => edit({ ...config, decode: { ...config.decode, maxTokens: Number(e.target.value) } })} />
          </div>
          <p className="eyebrow">{t("campaign.concurrency")}</p>
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.concurrency")}>
            {CAMPAIGN_CONCURRENCIES.map((n) => (
              <button key={n} type="button" className={`bench-conc-btn${config.decode.concurrencies.includes(n) ? " is-on" : ""}`} aria-pressed={config.decode.concurrencies.includes(n)}
                onClick={() => edit({ ...config, decode: { ...config.decode, concurrencies: toggleNumber(config.decode.concurrencies, n) } })}>×{n}</button>
            ))}
          </div>
          <p className="eyebrow">{t("campaign.startContext")}</p>
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.startContext")}>
            {CAMPAIGN_DECODE_CONTEXTS.map((n) => (
              <button key={n} type="button" className={`bench-conc-btn${config.decode.contextTokens === n ? " is-on" : ""}`} aria-pressed={config.decode.contextTokens === n}
                onClick={() => edit({ ...config, decode: { ...config.decode, contextTokens: n } })}>{n === 0 ? t("campaign.emptyContext") : formatContextSize(n)}</button>
            ))}
          </div>
          <p className="eyebrow">{t("campaign.promptTypes")}</p>
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.promptTypes")}>
            {CAMPAIGN_PROMPT_TYPES.map((type) => (
              <button key={type} type="button" className={`bench-conc-btn${config.decode.promptTypes.includes(type) ? " is-on" : ""}`} aria-pressed={config.decode.promptTypes.includes(type)}
                onClick={() => {
                  const has = config.decode.promptTypes.includes(type);
                  const promptTypes = has ? config.decode.promptTypes.filter((item) => item !== type) : [...config.decode.promptTypes, type];
                  edit({ ...config, decode: { ...config.decode, promptTypes } });
                }}>{promptLabel(t, type)}</button>
            ))}
          </div>

          <h3 className="bench-sheet__section-title">{t("campaign.stage.prefill")}</h3>
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.prefillSizes")}>
            {CAMPAIGN_PREFILL_SIZES.map((n) => (
              <button key={n} type="button" className={`bench-conc-btn${config.prefill.contextSizes.includes(n) ? " is-on" : ""}`} aria-pressed={config.prefill.contextSizes.includes(n)}
                onClick={() => edit({ ...config, prefill: { contextSizes: toggleNumber(config.prefill.contextSizes, n) } })}>{formatContextSize(n)}</button>
            ))}
          </div>

          <h3 className="bench-sheet__section-title">{t("campaign.stage.quality")}</h3>
          <label className="bp-field">
            <span className="eyebrow">{t("campaign.qualityProfile")}</span>
            <select className="bench-input" value={config.quality.profile === "default" ? "default" : "full"} onChange={(e) => {
              if (e.target.value === "default") edit({ ...config, quality: { profile: "default" } });
              else edit({ ...config, quality: { profile: "full", longSizes: config.quality.longSizes?.length ? config.quality.longSizes : [131072], longItems: config.quality.longItems ?? 3 } });
            }}>
              <option value="full">{t("campaign.qualityFull")}</option>
              <option value="default">{t("campaign.qualityDefault")}</option>
            </select>
          </label>
          <p className="bench-sheet__hint">{config.quality.profile === "default" ? t("campaign.qualityDefaultHelp") : t("campaign.qualityFullHelp")}</p>
          {config.quality.profile !== "default" ? (
            <>
              <p className="eyebrow">{t("campaign.longRecall")}</p>
              <div className="bench-conc-grid" role="group" aria-label={t("campaign.longRecall")}>
                {CAMPAIGN_LONG_SIZES.map((n) => {
                  const on = (config.quality.longSizes ?? []).length === 1 && config.quality.longSizes?.[0] === n;
                  return (
                    <button key={n} type="button" className={`bench-conc-btn${on ? " is-on" : ""}`} aria-pressed={on}
                      onClick={() => edit({ ...config, quality: { ...config.quality, profile: "full", longSizes: [n], longItems: config.quality.longItems ?? 3 } })}>{formatContextSize(n)}</button>
                  );
                })}
              </div>
              <p className="bench-sheet__hint">{t("campaign.longRecallHelp")}</p>
            </>
          ) : null}

          <h3 className="bench-sheet__section-title">{t("campaign.stage.tool-eval")}</h3>
          <label className="bp-field">
            <span className="eyebrow">{t("campaign.toolProfile")}</span>
            <select className="bench-input" value={config.toolEval.template} onChange={(e) => edit({ ...config, toolEval: { template: e.target.value as ToolEvalTemplate } })}>
              {TOOL_TEMPLATES.map((id) => <option key={id} value={id}>{toolLabel(t, id)}</option>)}
            </select>
          </label>
          <p className="bench-sheet__hint">{toolHelp(t, config.toolEval.template)}</p>
        </div>
      }
      runBar={
        <>
          {active ? (
            <button type="button" className="btn" onClick={() => requestCampaignStop(active.id)}>{t("campaign.stop")}</button>
          ) : (
            <button type="button" className="btn btn--primary" disabled={invalid} onClick={start}>{t("campaign.run")}</button>
          )}
          <p className="bench-sheet__hint">{t("campaign.stopHelp")}</p>
        </>
      }
    >
      {waitingForTool ? (
        <PageCard title={t("campaign.waitingTool")}>
          <p>{t("campaign.waitingToolBody")}</p>
        </PageCard>
      ) : null}
      {active ? (
        <PageCard title={t("campaign.runningStage", { stage: stageLabel(t, active.stage) })}>
          <StageList run={active} />
          {active.error ? <p>{explainError(t, active.error)}</p> : null}
        </PageCard>
      ) : null}

      <PageCard title={t("campaign.history")}>
        {mine.length === 0 ? <PageEmpty title={t("campaign.history")}>{t("campaign.empty")}</PageEmpty> : (
          <ul className="campaign-history">
            {mine.map((run) => (
              <li key={run.id}>
                <button type="button" className={`bench-conc-btn${focused?.id === run.id ? " is-on" : ""}`} aria-pressed={focused?.id === run.id} onClick={() => setFocusId(run.id)}>
                  <b>{new Date(run.startedAt).toLocaleString()}</b>
                  {" · "}{campaignTitle(run) || t("campaign.unknownModel")}
                  {" · "}{statusLabel(t, run.status)}
                  {run.stage ? ` · ${stageLabel(t, run.stage)}` : ""}
                </button>
                <div>{headlineLine(run)}</div>
                {run.error ? <div>{explainError(t, run.error)}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </PageCard>

      {focused ? (
        <PageCard title={t("campaign.results")}>
          <div className="bench-conc-grid" role="group" aria-label={t("campaign.view")}>
            <button type="button" className={`bench-conc-btn${view === "headline" ? " is-on" : ""}`} aria-pressed={view === "headline"} onClick={() => setView("headline")}>{t("campaign.headline")}</button>
            <button type="button" className={`bench-conc-btn${view === "detailed" ? " is-on" : ""}`} aria-pressed={view === "detailed"} onClick={() => setView("detailed")}>{t("campaign.detailed")}</button>
          </div>
          <CampaignReport run={focused} view={view} />
        </PageCard>
      ) : null}

      <PageCard title={t("campaign.compare")}>
        <div className="campaign-picks">
          <RunSelect label={t("campaign.compareA")} value={pickA} runs={runs} onChange={setPickA} />
          <RunSelect label={t("campaign.compareB")} value={pickB} runs={runs} onChange={setPickB} />
        </div>
        {runA && runB && !paired ? (
          <div>
            <p>{t("campaign.notComparable")}</p>
            <ul>{diffs.map((field) => <li key={field}>{diffLabel(t, field)}</li>)}</ul>
          </div>
        ) : null}
        {runA && runB ? <CampaignCompare a={runA} b={runB} view={view} /> : null}
      </PageCard>
    </PageLayout>
  );
}

function promptLabel(t: (key: string) => string, type: string): string {
  switch (type) {
    case "structured": return t("campaign.prompt.structured");
    case "prose": return t("campaign.prompt.prose");
    case "code": return t("campaign.prompt.code");
    case "json": return t("campaign.prompt.json");
    default: return type;
  }
}

function toolLabel(t: (key: string) => string, template: ToolEvalTemplate): string {
  switch (template) {
    case "short": return t("campaign.tool.short");
    case "regular": return t("campaign.tool.regular");
    case "regular-hard": return t("campaign.tool.regular-hard");
    case "hard": return t("campaign.tool.hard");
  }
}

function toolHelp(t: (key: string) => string, template: ToolEvalTemplate): string {
  switch (template) {
    case "short": return t("campaign.toolHelp.short");
    case "regular": return t("campaign.toolHelp.regular");
    case "regular-hard": return t("campaign.toolHelp.regular-hard");
    case "hard": return t("campaign.toolHelp.hard");
  }
}

function statusLabel(t: (key: string) => string, status: CampaignRun["status"]): string {
  switch (status) {
    case "running": return t("campaign.status.running");
    case "completed": return t("campaign.status.completed");
    case "failed": return t("campaign.status.failed");
    case "stopped": return t("campaign.status.stopped");
  }
}

function configValid(config: CampaignConfig): boolean {
  const temp = config.decode.temperature;
  const tokens = config.decode.maxTokens;
  return config.decode.concurrencies.length > 0
    && config.decode.promptTypes.length > 0
    && config.prefill.contextSizes.length > 0
    && Number.isFinite(temp) && temp >= 0 && temp <= 2
    && Number.isInteger(tokens) && tokens >= 64 && tokens <= 2048;
}

function stageLabel(t: (key: string, options?: Record<string, unknown>) => string, stage: CampaignStage | null): string {
  if (stage === "decode") return t("campaign.stage.decode");
  if (stage === "prefill") return t("campaign.stage.prefill");
  if (stage === "quality") return t("campaign.stage.quality");
  if (stage === "tool-eval") return t("campaign.stage.tool-eval");
  return t("campaign.stage.waiting");
}

function explainError(t: (key: string, options?: Record<string, unknown>) => string, error: string): string {
  if (error === "busy:decode") return t("campaign.busy.decode");
  if (error === "busy:prefill") return t("campaign.busy.prefill");
  if (error === "busy:quality") return t("campaign.busy.quality");
  if (error === "busy:tool-eval") return t("campaign.busy.toolEval");
  if (error === "busy:install") return t("campaign.busy.install");
  if (error === "decode" || error === "prefill" || error === "quality" || error === "tool-eval") {
    return t("campaign.leftRunning", { stage: stageLabel(t, error) });
  }
  return t("campaign.contact", { message: error });
}

function headlineLine(run: CampaignRun): string {
  const h = run.headlines;
  return `${num(h.decodeAgg)} tok/s · ${num(h.prefillTps)} tok/s · ${num(h.qualityPct)}% · ${num(h.toolScore)}`;
}

function StageList({ run }: { run: CampaignRun }) {
  const { t } = useTranslation("benchmarks");
  return (
    <ol>
      {CAMPAIGN_STAGES.map((stage) => {
        const id = stage === "tool-eval" ? run.jobs.toolEval : run.jobs[stage];
        const mark = id ? (run.stage === stage && run.status === "running" ? t("campaign.stageNow") : t("campaign.stageDone")) : t("campaign.stageWaiting");
        return <li key={stage}>{stageLabel(t, stage)} — {mark}</li>;
      })}
    </ol>
  );
}

function RunSelect({ label, value, runs, onChange }: { label: string; value: string; runs: CampaignRun[]; onChange: (id: string) => void }) {
  return (
    <label className="bp-field">
      <span className="eyebrow">{label}</span>
      <select className="bench-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {new Date(run.startedAt).toLocaleString()} · {campaignTitle(run) || run.sparkId}
          </option>
        ))}
      </select>
    </label>
  );
}

function diffLabel(t: (key: string) => string, field: CampaignDiffField): string {
  switch (field) {
    case "decode.thinking": return t("campaign.diff.decodeThinking");
    case "decode.temperature": return t("campaign.diff.decodeTemperature");
    case "decode.concurrencies": return t("campaign.diff.decodeConcurrency");
    case "decode.context": return t("campaign.diff.decodeContext");
    case "decode.promptTypes": return t("campaign.diff.decodePrompts");
    case "decode.maxTokens": return t("campaign.diff.decodeMaxTokens");
    case "prefill.context": return t("campaign.diff.prefillContext");
    case "quality.profile": return t("campaign.diff.qualityProfile");
    case "toolEval.template": return t("campaign.diff.toolProfile");
    default: return field;
  }
}

