import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchToolEvalResult, fetchToolEvalRun, getDecodeBench, getPrefillBench, getQualityBench } from "../../../api/client";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob, QualityCategory, ToolEvalRun } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";
import { QUALITY_CATEGORY_LABELS } from "../../../shared/qualityBench.js";
import { normalizeToolResult, type NormToolResult } from "../tooleval/normalize";
import { campaignEngine, formatSectionDuration, type CampaignRun, type CampaignView } from "./campaign";
import { upsertCampaign } from "./campaignStore";

interface LoadedJobs {
  decode: DecodeBenchJob | null;
  prefill: PrefillBenchJob | null;
  quality: QualityBenchJob | null;
  tool: ToolEvalRun | null;
  toolDetail: NormToolResult | null;
}

function useCampaignJobs(run: CampaignRun | null): { jobs: LoadedJobs | null; error: string | null } {
  const [jobs, setJobs] = useState<LoadedJobs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decodeId = run?.jobs.decode ?? "";
  const prefillId = run?.jobs.prefill ?? "";
  const qualityId = run?.jobs.quality ?? "";
  const toolId = run?.jobs.toolEval ?? "";
  const sparkId = run?.sparkId ?? "";

  useEffect(() => {
    if (!run) {
      setJobs(null);
      return;
    }
    let stop = false;
    setError(null);
    (async () => {
      const [decode, prefill, quality, toolWrap] = await Promise.all([
        decodeId ? getDecodeBench(sparkId, decodeId).catch(() => null) : Promise.resolve(null),
        prefillId ? getPrefillBench(sparkId, prefillId).catch(() => null) : Promise.resolve(null),
        qualityId ? getQualityBench(sparkId, qualityId).catch(() => null) : Promise.resolve(null),
        toolId ? fetchToolEvalRun(sparkId, toolId).then((got) => got.run).catch(() => null) : Promise.resolve(null),
      ]);
      let toolDetail: NormToolResult | null = null;
      if (toolId) {
        try {
          const got = await fetchToolEvalResult(sparkId, toolId);
          toolDetail = normalizeToolResult(got.result);
        } catch {
          toolDetail = null;
        }
      }
      if (!stop) {
        setJobs({ decode, prefill, quality, tool: toolWrap, toolDetail });
        const engine = campaignEngine(run?.engine, quality?.engine?.record);
        if (run && engine && engine !== run.engine) upsertCampaign({ ...run, engine });
      }
    })().catch((err: unknown) => {
      if (!stop) setError(err instanceof Error ? err.message : "load");
    });
    return () => { stop = true; };
  }, [run, sparkId, decodeId, prefillId, qualityId, toolId]);

  return { jobs, error };
}

function num(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);
}

function delta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return "—";
  const d = b - a;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
}

function wallMs(start?: number | null, end?: number | null, fallback?: number | null): number | null {
  if (typeof start === "number" && typeof end === "number" && end >= start) return end - start;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) return fallback;
  return null;
}

type StageKey = "decode" | "prefill" | "quality" | "tool";

function stageMs(jobs: LoadedJobs): Record<StageKey, number | null> {
  return {
    decode: wallMs(jobs.decode?.startedAt, jobs.decode?.completedAt, jobs.decode?.durationMs),
    prefill: wallMs(jobs.prefill?.startedAt, jobs.prefill?.completedAt, jobs.prefill?.durationMs),
    quality: wallMs(jobs.quality?.startedAt, jobs.quality?.completedAt, jobs.quality?.durationMs),
    tool: wallMs(jobs.tool?.startedAt, jobs.tool?.finishedAt),
  };
}

function sumKnown(values: Array<number | null>): number | null {
  if (values.every((value) => value == null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function signedDuration(a: number | null, b: number | null): string {
  if (a == null || b == null) return "—";
  const diff = b - a;
  const text = formatSectionDuration(Math.abs(diff));
  if (diff > 0) return `+${text}`;
  if (diff < 0) return `−${text}`;
  return text;
}

const STAGE_KEYS: readonly StageKey[] = ["decode", "prefill", "quality", "tool"];

function stageLabel(t: (key: string) => string, key: StageKey): string {
  if (key === "decode") return t("campaign.stage.decode");
  if (key === "prefill") return t("campaign.stage.prefill");
  if (key === "quality") return t("campaign.stage.quality");
  return t("campaign.stage.tool-eval");
}

function SectionHeading({ label, times }: { label: string; times: string[] }) {
  return (
    <h3 className="bench-sheet__section-title">
      {label}
      {times.map((time, index) => <span key={index} className="bp-section-time">{time}</span>)}
    </h3>
  );
}

function StageTimeTable({ a, b }: { a: LoadedJobs; b?: LoadedJobs }) {
  const { t } = useTranslation("benchmarks");
  const left = stageMs(a);
  const right = b ? stageMs(b) : null;
  const leftTotal = sumKnown(STAGE_KEYS.map((key) => left[key]));
  const rightTotal = right ? sumKnown(STAGE_KEYS.map((key) => right[key])) : null;
  return (
    <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
      <thead>
        <tr>
          <th></th>
          <th className="bp-num">{right ? t("campaign.sideA") : t("campaign.sectionTime")}</th>
          {right ? <th className="bp-num">{t("campaign.sideB")}</th> : null}
          {right ? <th className="bp-num">{t("campaign.delta")}</th> : null}
        </tr>
      </thead>
      <tbody>
        {STAGE_KEYS.map((key) => (
          <tr key={key}>
            <td>{stageLabel(t, key)}</td>
            <td className="bp-num">{formatSectionDuration(left[key])}</td>
            {right ? <td className="bp-num">{formatSectionDuration(right[key])}</td> : null}
            {right ? <td className="bp-num">{signedDuration(left[key], right[key])}</td> : null}
          </tr>
        ))}
        <tr>
          <td>{t("campaign.total")}</td>
          <td className="bp-num">{formatSectionDuration(leftTotal)}</td>
          {right ? <td className="bp-num">{formatSectionDuration(rightTotal)}</td> : null}
          {right ? <td className="bp-num">{signedDuration(leftTotal, rightTotal)}</td> : null}
        </tr>
      </tbody>
    </table></div>
  );
}

function meanAtOne(job: DecodeBenchJob | null): number | null {
  const rows = (job?.results ?? []).filter((row) => row.concurrency === 1 && !row.error && Number.isFinite(row.aggregateDecodeTps));
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row.aggregateDecodeTps, 0) / rows.length;
}

function peakDecode(job: DecodeBenchJob | null): { label: string; value: number } | null {
  let best: { label: string; value: number } | null = null;
  for (const row of job?.results ?? []) {
    if (row.error || !Number.isFinite(row.aggregateDecodeTps)) continue;
    if (!best || row.aggregateDecodeTps > best.value) {
      best = { label: `${row.promptType ?? "decode"} ×${row.concurrency}`, value: row.aggregateDecodeTps };
    }
  }
  return best;
}

function prefillAt(job: PrefillBenchJob | null, tokens: number): number | null {
  const row = (job?.results ?? []).find((item) => item.targetTokens === tokens && !item.error);
  return row && Number.isFinite(row.prefillTps) ? row.prefillTps : null;
}

function largestPrefill(job: PrefillBenchJob | null): { tokens: number; tps: number } | null {
  let best: { tokens: number; tps: number } | null = null;
  for (const row of job?.results ?? []) {
    if (row.error || !Number.isFinite(row.prefillTps)) continue;
    if (!best || row.targetTokens > best.tokens) best = { tokens: row.targetTokens, tps: row.prefillTps };
  }
  return best;
}

export function CampaignReport({ run, view }: { run: CampaignRun; view: CampaignView }) {
  const { t } = useTranslation("benchmarks");
  const { jobs, error } = useCampaignJobs(run);
  return (
    <div>
      <SetupLine run={run} />
      {error ? <p>{t("campaign.contact", { message: error })}</p> : null}
      {!jobs ? <p>{t("campaign.loadingResults")}</p> : view === "headline" ? <Headline jobs={jobs} run={run} /> : <Detailed jobs={jobs} />}
    </div>
  );
}

export function CampaignCompare({ a, b, view }: { a: CampaignRun; b: CampaignRun; view: CampaignView }) {
  const { t } = useTranslation("benchmarks");
  const left = useCampaignJobs(a);
  const right = useCampaignJobs(b);
  if (!left.jobs || !right.jobs) return <p>{t("campaign.loadingResults")}</p>;
  if (view === "headline") return <HeadlineCompare a={left.jobs} b={right.jobs} runA={a} runB={b} />;
  return <DetailedCompare a={left.jobs} b={right.jobs} />;
}

function SetupLine({ run }: { run: CampaignRun }) {
  const { t } = useTranslation("benchmarks");
  const decode = run.config.decode;
  const quality = run.config.quality;
  const long = quality.longSizes?.length ? quality.longSizes.map((n) => formatContextSize(n)).join(", ") : "";
  const conc = decode.concurrencies.length ? `×${decode.concurrencies[0]}–×${decode.concurrencies[decode.concurrencies.length - 1]}` : "—";
  return (
    <p className="bench-sheet__hint">
      {decode.thinking ? t("campaign.thinkingOn") : t("campaign.thinkingOff")}
      {" · "}{t("campaign.temperature")} {decode.temperature}
      {" · "}{conc}
      {" · "}{decode.contextTokens ? formatContextSize(decode.contextTokens) : t("campaign.emptyContext")}
      {" · "}{t("campaign.stage.prefill")} {run.config.prefill.contextSizes.map((n) => formatContextSize(n)).join(", ")}
      {" · "}{t("campaign.stage.quality")} {qualityProfileLabel(t, quality.profile)}{long ? ` ${long}` : ""}
      {" · "}{toolLabel(t, run.config.toolEval.template)}
    </p>
  );
}

function Headline({ jobs, run, title }: { jobs: LoadedJobs; run: CampaignRun; title?: string }) {
  const { t } = useTranslation("benchmarks");
  const atOne = meanAtOne(jobs.decode) ?? run.headlines.decodeAgg;
  const peak = peakDecode(jobs.decode);
  const at16 = prefillAt(jobs.prefill, 16384);
  const largest = largestPrefill(jobs.prefill);
  const quality = jobs.quality?.results;
  const long = quality?.categories.long;
  const longSizes = jobs.quality?.config.longSizes ?? run.config.quality.longSizes ?? [];
  const tool = jobs.tool?.summary;
  return (
    <div>
      {title ? <h3 className="bench-sheet__section-title">{title}</h3> : null}
      <StageTimeTable a={jobs} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <tbody>
          <tr><td>{t("campaign.decodeAtOne")}</td><td>{num(atOne)} {t("campaign.toks")}</td></tr>
          <tr><td>{t("campaign.decodePeak")}</td><td>{peak ? `${peak.label} · ${num(peak.value)} ${t("campaign.toks")}` : "—"}</td></tr>
          <tr><td>{t("campaign.prefillAt16k")}</td><td>{at16 == null ? "—" : `${num(at16)} ${t("campaign.toks")}`}</td></tr>
          <tr><td>{t("campaign.prefillLargest")}</td><td>{largest ? `${formatContextSize(largest.tokens)} · ${num(largest.tps)} ${t("campaign.toks")}` : num(run.headlines.prefillTps)}</td></tr>
          <tr><td>{t("campaign.qualityOverall")}</td><td>{num(quality?.overallPct ?? run.headlines.qualityPct)}%{quality?.overallCi ? ` (${num(quality.overallCi[0])}–${num(quality.overallCi[1])})` : ""}</td></tr>
          <tr><td>{t("campaign.qualityLongKeys")}</td><td>{long?.keysPct == null ? "—" : `${num(long.keysPct)}% · ${longSizes.map((n) => formatContextSize(n)).join(", ") || "—"}`}</td></tr>
          <tr><td>{t("campaign.toolScore")}</td><td>{num(tool?.finalScore ?? run.headlines.toolScore)}{tool?.rating ? ` · ${tool.rating}` : ""}</td></tr>
          <tr><td>{t("campaign.toolDeploy")}</td><td>{num(tool?.deployability)} / {num(tool?.responsiveness)}</td></tr>
          <tr><td>{t("campaign.toolCounts")}</td><td>{tool?.counts ? `${tool.counts.pass} / ${tool.counts.partial} / ${tool.counts.fail}` : "—"}</td></tr>
        </tbody>
      </table></div>
    </div>
  );
}

function Detailed({ jobs }: { jobs: LoadedJobs }) {
  const { t } = useTranslation("benchmarks");
  const decode = [...(jobs.decode?.results ?? [])].sort((a, b) => (a.promptType ?? "").localeCompare(b.promptType ?? "") || a.concurrency - b.concurrency);
  const prefill = [...(jobs.prefill?.results ?? [])].sort((a, b) => a.targetTokens - b.targetTokens);
  const categories = Object.entries(jobs.quality?.results?.categories ?? {}) as Array<[QualityCategory, NonNullable<QualityBenchJob["results"]>["categories"][QualityCategory]]>;
  const times = stageMs(jobs);
  return (
    <div>
      <SectionHeading label={t("campaign.stage.decode")} times={[formatSectionDuration(times.decode)]} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead>
          <tr>
            <th>{t("campaign.colType")}</th>
            <th>{t("campaign.colConc")}</th>
            <th>{t("campaign.colAggregate")}</th>
            <th>{t("campaign.colStream")}</th>
            <th>{t("campaign.colTtft")}</th>
          </tr>
        </thead>
        <tbody>
          {decode.map((row) => (
            <tr key={`${row.promptType}-${row.concurrency}`}>
              <td>{promptLabel(t, row.promptType ?? "")}</td>
              <td>×{row.concurrency}</td>
              <td>{row.error ? row.error : num(row.aggregateDecodeTps)}</td>
              <td>{num(row.meanDecodeTps)}</td>
              <td>{num(row.meanTtftMs)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <SectionHeading label={t("campaign.stage.prefill")} times={[formatSectionDuration(times.prefill)]} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead>
          <tr><th>{t("campaign.colSize")}</th><th>{t("campaign.toks")}</th><th>{t("campaign.colTtft")}</th></tr>
        </thead>
        <tbody>
          {prefill.map((row) => (
            <tr key={row.targetTokens}>
              <td>{formatContextSize(row.targetTokens)}</td>
              <td>{row.error ? row.error : num(row.prefillTps)}</td>
              <td>{num(row.ttftMs)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <SectionHeading label={t("campaign.stage.quality")} times={[formatSectionDuration(times.quality)]} />
      <p className="bench-sheet__hint">
        {t("campaign.qualityLongKeys")} { (jobs.quality?.config.longSizes ?? []).map((n) => formatContextSize(n)).join(", ") || "—" }
      </p>
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead>
          <tr><th>{t("campaign.colCategory")}</th><th>{t("campaign.colPct")}</th><th>{t("campaign.colPassed")}</th></tr>
        </thead>
        <tbody>
          {categories.map(([cat, summary]) => summary ? (
            <tr key={cat}>
              <td>{QUALITY_CATEGORY_LABELS[cat] ?? cat}</td>
              <td>{num(summary.pct)}{summary.ci ? ` (${num(summary.ci[0])}–${num(summary.ci[1])})` : ""}{summary.keysPct != null ? ` · ${num(summary.keysPct)}%` : ""}</td>
              <td>{summary.passed}/{summary.scored ?? summary.total}</td>
            </tr>
          ) : null)}
        </tbody>
      </table></div>
      <ToolDetail tool={jobs.tool} detail={jobs.toolDetail} time={formatSectionDuration(times.tool)} />
    </div>
  );
}

function ToolDetail({ tool, detail, time }: { tool: ToolEvalRun | null; detail: NormToolResult | null; time: string }) {
  const { t } = useTranslation("benchmarks");
  const summary = tool?.summary;
  const categories = detail?.categories ?? [];
  return (
    <div>
      <SectionHeading label={t("campaign.stage.tool-eval")} times={[time]} />
      <p>
        {num(summary?.finalScore ?? detail?.score)}
        {summary?.rating || detail?.rating ? ` · ${summary?.rating || detail?.rating}` : ""}
        {" · "}{t("campaign.toolDeploy")} {num(summary?.deployability ?? detail?.deployability)}
        {" · "}{t("campaign.toolResponse")} {num(summary?.responsiveness ?? detail?.responsiveness)}
      </p>
      {categories.length ? (
        <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
          <thead><tr><th>{t("campaign.colCategory")}</th><th>{t("campaign.colPct")}</th></tr></thead>
          <tbody>
            {categories.map((row) => (
              <tr key={row.id}>
                <td>{row.name || row.id}</td>
                <td>{num(row.percent)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </div>
  );
}

function HeadlineCompare({ a, b, runA, runB }: { a: LoadedJobs; b: LoadedJobs; runA: CampaignRun; runB: CampaignRun }) {
  const { t } = useTranslation("benchmarks");
  const rows: Array<[string, number | null, number | null]> = [
    [t("campaign.decodeAtOne"), meanAtOne(a.decode) ?? runA.headlines.decodeAgg, meanAtOne(b.decode) ?? runB.headlines.decodeAgg],
    [t("campaign.prefillAt16k"), prefillAt(a.prefill, 16384), prefillAt(b.prefill, 16384)],
    [t("campaign.prefillLargest"), largestPrefill(a.prefill)?.tps ?? runA.headlines.prefillTps, largestPrefill(b.prefill)?.tps ?? runB.headlines.prefillTps],
    [t("campaign.qualityOverall"), a.quality?.results?.overallPct ?? runA.headlines.qualityPct, b.quality?.results?.overallPct ?? runB.headlines.qualityPct],
    [t("campaign.toolScore"), a.tool?.summary?.finalScore ?? runA.headlines.toolScore, b.tool?.summary?.finalScore ?? runB.headlines.toolScore],
  ];
  return (
    <>
      <StageTimeTable a={a} b={b} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
      <thead>
        <tr><th>{t("campaign.headlineCard")}</th><th className="bp-num">{t("campaign.sideA")}</th><th className="bp-num">{t("campaign.sideB")}</th><th className="bp-num">{t("campaign.delta")}</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, left, right]) => (
          <tr key={label}><td>{label}</td><td className="bp-num">{num(left)}</td><td className="bp-num">{num(right)}</td><td className="bp-num">{delta(left, right)}</td></tr>
        ))}
      </tbody>
    </table></div>
    </>
  );
}

function DetailedCompare({ a, b }: { a: LoadedJobs; b: LoadedJobs }) {
  const { t } = useTranslation("benchmarks");
  const decodeKeys = new Map<string, { type: string; concurrency: number; left?: number; right?: number }>();
  const takeDecode = (job: DecodeBenchJob | null, side: "left" | "right") => {
    for (const row of job?.results ?? []) {
      const key = `${row.promptType ?? ""}:${row.concurrency}`;
      const slot = decodeKeys.get(key) ?? { type: row.promptType ?? "", concurrency: row.concurrency };
      if (!row.error && Number.isFinite(row.aggregateDecodeTps)) slot[side] = row.aggregateDecodeTps;
      decodeKeys.set(key, slot);
    }
  };
  takeDecode(a.decode, "left");
  takeDecode(b.decode, "right");
  const prefillKeys = new Map<number, { left?: number; right?: number }>();
  const takePrefill = (job: PrefillBenchJob | null, side: "left" | "right") => {
    for (const row of job?.results ?? []) {
      const slot = prefillKeys.get(row.targetTokens) ?? {};
      if (!row.error && Number.isFinite(row.prefillTps)) slot[side] = row.prefillTps;
      prefillKeys.set(row.targetTokens, slot);
    }
  };
  takePrefill(a.prefill, "left");
  takePrefill(b.prefill, "right");
  const qualityKeys = new Set<QualityCategory>([
    ...Object.keys(a.quality?.results?.categories ?? {}),
    ...Object.keys(b.quality?.results?.categories ?? {}),
  ] as QualityCategory[]);
  const leftTimes = stageMs(a);
  const rightTimes = stageMs(b);
  const pair = (key: StageKey) => [`${t("campaign.sideA")} ${formatSectionDuration(leftTimes[key])}`, `${t("campaign.sideB")} ${formatSectionDuration(rightTimes[key])}`];
  return (
    <div>
      <SectionHeading label={t("campaign.stage.decode")} times={pair("decode")} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead><tr><th>{t("campaign.colType")}</th><th className="bp-num">{t("campaign.colConc")}</th><th className="bp-num">{t("campaign.sideA")}</th><th className="bp-num">{t("campaign.sideB")}</th><th className="bp-num">{t("campaign.delta")}</th></tr></thead>
        <tbody>
          {[...decodeKeys.values()].sort((x, y) => x.type.localeCompare(y.type) || x.concurrency - y.concurrency).map((row) => (
            <tr key={`${row.type}-${row.concurrency}`}><td>{promptLabel(t, row.type)}</td><td className="bp-num">×{row.concurrency}</td><td className="bp-num">{num(row.left)}</td><td className="bp-num">{num(row.right)}</td><td className="bp-num">{delta(row.left, row.right)}</td></tr>
          ))}
        </tbody>
      </table></div>
      <SectionHeading label={t("campaign.stage.prefill")} times={pair("prefill")} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead><tr><th>{t("campaign.colSize")}</th><th className="bp-num">{t("campaign.sideA")}</th><th className="bp-num">{t("campaign.sideB")}</th><th className="bp-num">{t("campaign.delta")}</th></tr></thead>
        <tbody>
          {[...prefillKeys.entries()].sort((x, y) => x[0] - y[0]).map(([tokens, row]) => (
            <tr key={tokens}><td>{formatContextSize(tokens)}</td><td className="bp-num">{num(row.left)}</td><td className="bp-num">{num(row.right)}</td><td className="bp-num">{delta(row.left, row.right)}</td></tr>
          ))}
        </tbody>
      </table></div>
      <SectionHeading label={t("campaign.stage.quality")} times={pair("quality")} />
      <div className="bp-table-wrap"><table className="bp-table bp-table--fit">
        <thead><tr><th>{t("campaign.colCategory")}</th><th className="bp-num">{t("campaign.sideA")}</th><th className="bp-num">{t("campaign.sideB")}</th><th className="bp-num">{t("campaign.delta")}</th></tr></thead>
        <tbody>
          {[...qualityKeys].map((cat) => {
            const left = a.quality?.results?.categories[cat]?.pct;
            const right = b.quality?.results?.categories[cat]?.pct;
            return <tr key={cat}><td>{QUALITY_CATEGORY_LABELS[cat] ?? cat}</td><td className="bp-num">{num(left)}</td><td className="bp-num">{num(right)}</td><td className="bp-num">{delta(left, right)}</td></tr>;
          })}
        </tbody>
      </table></div>
      <SectionHeading label={t("campaign.stage.tool-eval")} times={pair("tool")} />
    </div>
  );
}

function promptLabel(t: (key: string) => string, type: string): string {
  switch (type) {
    case "structured": return t("campaign.prompt.structured");
    case "prose": return t("campaign.prompt.prose");
    case "code": return t("campaign.prompt.code");
    case "json": return t("campaign.prompt.json");
    default: return type || "—";
  }
}

function toolLabel(t: (key: string) => string, template: CampaignRun["config"]["toolEval"]["template"]): string {
  switch (template) {
    case "short": return t("campaign.tool.short");
    case "regular": return t("campaign.tool.regular");
    case "regular-hard": return t("campaign.tool.regular-hard");
    case "hard": return t("campaign.tool.hard");
  }
}

function qualityProfileLabel(t: (key: string) => string, profile: CampaignRun["config"]["quality"]["profile"]): string {
  switch (profile) {
    case "full": return t("campaign.qualityFull");
    case "default": return t("campaign.qualityDefault");
    case "default-16k": return t("campaign.qualityLong");
    case "recorded": return t("campaign.qualityRecorded");
  }
}
