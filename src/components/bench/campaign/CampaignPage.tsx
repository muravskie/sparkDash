import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";
import { BenchTargetFrame, type BenchTargetProps } from "../sparkdash/BenchTargetFrame";
import { PageCard, PageEmpty, PageLayout } from "../sparkdash/pageParts";
import {
  CAMPAIGN_CONCURRENCIES,
  CAMPAIGN_DECODE_CONTEXTS,
  CAMPAIGN_PREFILL_SIZES,
  CAMPAIGN_PROMPT_TYPES,
  CAMPAIGN_STAGES,
  asCustom,
  campaignDiffs,
  campaignsComparable,
  configForPreset,
  createCampaign,
  headlineConfig,
  type CampaignConfig,
  type CampaignDiffField,
  type CampaignPreset,
  type CampaignRun,
  type CampaignStage,
  type QualityCampaignProfile,
  type ToolEvalTemplate,
} from "./campaign";
import { remoteOf } from "./campaignClient";
import { kickCampaign, requestCampaignStop, resumeRunningCampaigns } from "./campaignSession";
import { upsertCampaign, useCampaigns } from "./campaignStore";

const TOOL_TEMPLATES: ToolEvalTemplate[] = ["short", "regular", "regular-hard", "hard"];

function num(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function delta(a: number | null, b: number | null): string {
  if (a == null || b == null) return "—";
  const d = b - a;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
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
  const [config, setConfig] = useState<CampaignConfig>(() => headlineConfig());
  const [pickA, setPickA] = useState("");
  const [pickB, setPickB] = useState("");

  useEffect(() => {
    resumeRunningCampaigns();
  }, []);

  const mine = runs.filter((run) => run.sparkId === target.sparkId);
  const active = mine.find((run) => run.status === "running") ?? null;
  const invalid = !configValid(config);

  const applyPreset = (preset: Exclude<CampaignPreset, "custom">) => {
    setConfig(configForPreset(preset));
  };
  const edit = (next: CampaignConfig) => setConfig(asCustom(next));

  const start = () => {
    if (active || invalid) return;
    const remote = remoteOf(target.remoteTarget);
    const run = createCampaign({
      sparkId: target.sparkId,
      port: remote.port ?? target.llmPort,
      modelId: target.modelId,
      host: remote.host,
      tls: remote.tls,
      config,
    });
    upsertCampaign(run);
    kickCampaign(run.id);
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
            <PresetButton id="headline" current={config.preset} label={t("campaign.headline")} onClick={() => applyPreset("headline")} />
            <PresetButton id="detailed" current={config.preset} label={t("campaign.detailed")} onClick={() => applyPreset("detailed")} />
          </div>
          {config.preset === "custom" ? <p className="bench-sheet__hint">{t("campaign.custom")}</p> : null}

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
            <select className="bench-input" value={config.quality.profile} onChange={(e) => edit({ ...config, quality: { profile: e.target.value as QualityCampaignProfile } })}>
              <option value="default">{t("campaign.qualityDefault")}</option>
              <option value="default-16k">{t("campaign.qualityLong")}</option>
            </select>
          </label>
          <p className="bench-sheet__hint">{config.quality.profile === "default" ? t("campaign.qualityDefaultHelp") : t("campaign.qualityLongHelp")}</p>

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
                <b>{new Date(run.startedAt).toLocaleString()}</b>
                {" · "}{run.modelId || t("campaign.unknownModel")}
                {" · "}{statusLabel(t, run.status)}
                {run.stage ? ` · ${stageLabel(t, run.stage)}` : ""}
                <div>{headlineLine(run)}</div>
                {run.error ? <div>{explainError(t, run.error)}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </PageCard>

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
        {runA && runB && paired ? <CompareTable a={runA} b={runB} /> : null}
        {runA ? <HeadlineCard title={t("campaign.sideA")} run={runA} /> : null}
        {runB ? <HeadlineCard title={t("campaign.sideB")} run={runB} /> : null}
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

function PresetButton({ id, current, label, onClick }: { id: CampaignPreset; current: CampaignPreset; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`bench-conc-btn${current === id ? " is-on" : ""}`} aria-pressed={current === id} onClick={onClick}>{label}</button>
  );
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
            {new Date(run.startedAt).toLocaleString()} · {run.modelId || run.sparkId}
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

function CompareTable({ a, b }: { a: CampaignRun; b: CampaignRun }) {
  const { t } = useTranslation("benchmarks");
  const rows = [
    [t("campaign.decodeAtOne"), a.headlines.decodeAgg, b.headlines.decodeAgg],
    [t("campaign.prefillAt"), a.headlines.prefillTps, b.headlines.prefillTps],
    [t("campaign.qualityOverall"), a.headlines.qualityPct, b.headlines.qualityPct],
    [t("campaign.toolScore"), a.headlines.toolScore, b.headlines.toolScore],
  ] as const;
  return (
    <table>
      <thead>
        <tr><th>{t("campaign.headlineCard")}</th><th>{t("campaign.sideA")}</th><th>{t("campaign.sideB")}</th><th>{t("campaign.delta")}</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, left, right]) => (
          <tr key={label}><td>{label}</td><td>{num(left)}</td><td>{num(right)}</td><td>{delta(left, right)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function HeadlineCard({ title, run }: { title: string; run: CampaignRun }) {
  const { t } = useTranslation("benchmarks");
  const levels = run.headlines.decodeLevels;
  return (
    <div>
      <h3 className="bench-sheet__section-title">{title}</h3>
      <p>{headlineLine(run)}</p>
      {levels.length ? (
        <ul>
          {levels.map((row) => (
            <li key={`${row.type}-${row.concurrency}`}>{promptLabel(t, row.type)} ×{row.concurrency} · {row.aggregate.toFixed(1)} {t("campaign.toks")}</li>
          ))}
        </ul>
      ) : null}
      {run.headlines.prefillRows.length ? (
        <ul>
          {run.headlines.prefillRows.map((row) => (
            <li key={row.tokens}>{formatContextSize(row.tokens)} · {row.tps.toFixed(1)} {t("campaign.toks")}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
