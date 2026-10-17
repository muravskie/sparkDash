import { useEffect, useRef } from "react";
import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { BenchSparksContext } from "../bench/SparkChips";
import { BenchTargetFrame, type BenchTargetProps } from "../bench/sparkdash/BenchTargetFrame";
import { useBenchSpark } from "../bench/useBenchSpark";
import type { Model } from "./lit/model";
import type { Playground } from "./lit/view";
import "./lit/view";
import "./llm-playground.css";

function modelFor(target: BenchTargetProps, online: boolean): Model {
  const provider = target.providerModel;
  if (provider) {
    return {
      id: `${target.engine}:${provider.id}`,
      name: provider.name,
      healthy: target.providerCredential === true,
      engine: target.engine,
      upstreamId: provider.id,
      price: provider.cost,
    };
  }
  const remote = target.remoteTarget;
  const where = remote
    ? `remote:${remote.host}:${remote.port}:${remote.tls ? "tls" : "plain"}`
    : `port:${target.llmPort}`;
  return {
    id: `${target.sparkId}:${where}`,
    name: target.modelId || target.sparkName,
    healthy: Boolean(remote) || online,
    engine: target.engine,
  };
}

function probeFor(sparks: readonly SparkSnapshot[], sparkId: string, port: number, remote: boolean): LlmMetrics | null {
  if (remote) return null;
  const spark = sparks.find((item) => item.id === sparkId);
  if (!spark) return null;
  const ports = spark.llmPorts?.length ? spark.llmPorts : spark.llmPort ? [spark.llmPort] : [];
  const index = ports.indexOf(port);
  if (index >= 0) return spark.metrics.llm?.[index] ?? null;
  return spark.metrics.llm?.find((row) => row.port === port) ?? null;
}

/** Their playground, pointed at the benchmark Spark, port, key, and tunnel. */
function LlmPlayground({ target, online, probe }: { target: BenchTargetProps; online: boolean; probe: LlmMetrics | null }) {
  const ref = useRef<Playground | null>(null);
  const remote = target.remoteTarget;
  const provider = target.providerModel;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const port = remote?.port ?? target.llmPort;
    const host = provider ? "" : remote?.host ?? "";
    const tls = Boolean(remote?.tls);
    const external = Boolean(provider);
    const stale = !provider && !remote && !online;
    const model = modelFor(target, online);
    if (el.sparkId !== target.sparkId) el.sparkId = target.sparkId;
    if (el.llmPort !== port) el.llmPort = port;
    if (el.remoteHost !== host) el.remoteHost = host;
    if (el.remoteTls !== tls) el.remoteTls = tls;
    if (el.external !== external) el.external = external;
    if (el.stale !== stale) el.stale = stale;
    if (el.probe !== probe) el.probe = probe;
    const current = el.model;
    const priceSame = JSON.stringify(current?.price ?? null) === JSON.stringify(model.price ?? null);
    if (!current || current.id !== model.id || current.name !== model.name || current.healthy !== model.healthy || current.engine !== model.engine || current.upstreamId !== model.upstreamId || !priceSame) {
      el.model = model;
    }
  });
  return (
    <div className="llm-playground">
      <spark-playground ref={ref} />
    </div>
  );
}

/** Streaming playground. The Spark picker is the one the benchmark pages use. */
export function PlaygroundPage({ sparks }: { sparks: readonly SparkSnapshot[] }) {
  const { spark, select, eligible } = useBenchSpark(sparks);
  return (
    <BenchSparksContext.Provider value={{ sparks: eligible, onSelect: select }}>
      <BenchTargetFrame spark={spark} remoteForm="provider">
        {(target) => (
          <LlmPlayground
            target={target}
            online={Boolean(spark?.online)}
            probe={probeFor(sparks, target.sparkId, target.llmPort, Boolean(target.remoteTarget) || Boolean(target.providerModel))}
          />
        )}
      </BenchTargetFrame>
    </BenchSparksContext.Provider>
  );
}
