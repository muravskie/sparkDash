/**
 * Playground HTTP routes. Target resolution (port, API key, SSH tunnel)
 * is the same `benchHttpTarget` decode uses.
 */

import { formatLlmBaseUrl } from "../../src/shared/llmTarget.js";
import { runStreamingRequest } from "../collectors/LlmStreaming.js";
import { emptyTurn, reduceStreamDelta } from "./deltas.js";
import { readEngineContext } from "./engineInfo.js";
import { loadGenerationDefaults } from "./generationDefaults.js";
import { handleOpencodeGoStream, handleOpencodeStream, loadOpencodeCatalog, loadOpencodeGoCatalog } from "./opencodeGo.js";
import { handleOpenRouterStream, loadOpenRouterCatalog } from "./openrouter.js";
import { proxyChatStream } from "./passthrough.js";
import { buildChatBody, messagesForReplay, parseConcurrency } from "./requestBody.js";

/**
 * @param {import("express").Response} res
 */
function disconnectController(res) {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac;
}

/**
 * @param {object} spark
 */
function configuredPorts(spark) {
  if (Array.isArray(spark?.llmPorts) && spark.llmPorts.length) return spark.llmPorts;
  const n = Number(spark?.llmPort);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
  return [];
}

/**
 * @param {{ getSpark: (id: string) => object | null }} registry
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
function loadSpark(registry, req, res) {
  const spark = registry.getSpark(req.params.id);
  if (!spark) {
    res.status(404).json({ error: "Spark not found" });
    return null;
  }
  if (spark.workerNode) {
    res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
    return null;
  }
  if (spark.llmMonitoring === false) {
    res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
    return null;
  }
  return spark;
}

/**
 * @param {import("express").Request} req
 */
function targetInput(req) {
  if (req.method === "GET") {
    const tls = req.query.tls;
    return {
      port: req.query.port,
      host: req.query.host,
      tls: tls === "1" || tls === "true",
    };
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

/**
 * @param {Map<string, { snapshot?: () => object }>} monitors
 * @param {object} spark
 * @param {number} port
 */
function probeRow(monitors, spark, port) {
  const snap = monitors.get(spark.id)?.snapshot?.();
  const list = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
  const byPort = list.find((row) => Number(row?.port) === port);
  if (byPort) return byPort;
  const ports = configuredPorts(spark);
  const index = ports.indexOf(port);
  return index >= 0 ? list[index] || null : null;
}

/**
 * @param {object} deps
 * @param {object} spark
 * @param {object} body
 * @param {AbortSignal} signal
 */
async function openTarget(deps, spark, body, signal) {
  const ports = configuredPorts(spark);
  const target = await deps.benchHttpTarget(spark, ports, body);
  const opened = await target.resolveTarget({ signal });
  const baseUrl = formatLlmBaseUrl({
    host: opened.host,
    port: opened.port,
    tls: Boolean(opened.tls || target.tls),
  });
  const row = target.custom ? null : probeRow(deps.monitors, spark, target.port);
  const requestedModel = typeof body.modelId === "string" ? body.modelId.trim() : "";
  return {
    baseUrl,
    apiKey: target.apiKey,
    via: opened.via || (target.custom ? "direct" : null),
    backend: row?.backend ?? null,
    modelId: requestedModel || row?.modelId || null,
    close: () => {
      try {
        opened.close?.();
      } catch {
        /* tunnel cleanup is best-effort */
      }
    },
  };
}

/**
 * @param {import("express").Response} res
 * @param {unknown} payload
 */
function writeEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* the browser already went away */
  }
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} body
 * @param {AbortSignal} signal
 * @param {{ apiKey?: string | null, onState: (state: ReturnType<typeof emptyTurn>, chunk: unknown) => void }} opts
 */
async function streamChat(baseUrl, body, signal, opts) {
  let state = emptyTurn();
  let finishReason = null;
  let model = null;
  let lastWire = "";
  const requestBody = structuredClone(body);
  const result = await runStreamingRequest(`${baseUrl}/v1/chat/completions`, requestBody, signal, {
    apiKey: opts.apiKey,
    retryOnThinking400: opts.retryThinking === true,
    thinking: opts.thinkingOn === true,
    onEvent: (chunk) => {
      state = reduceStreamDelta(state, chunk);
      if (chunk && typeof chunk === "object") {
        if (typeof chunk.model === "string") model = chunk.model;
        const reason = chunk.choices?.[0]?.finish_reason;
        if (reason) finishReason = String(reason);
      }
      const wire = JSON.stringify(state);
      if (wire === lastWire) return;
      lastWire = wire;
      opts.onState(state, chunk);
    },
  });
  return { state, finishReason, model: result.model || model, error: result.error || null };
}

/**
 * @param {import("express").Response} res
 * @param {number} status
 * @param {string} message
 */
function fail(res, status, message) {
  if (res.headersSent || res.writableEnded) return;
  res.status(status).json({ error: message });
}

/**
 * @param {import("express").Express} app
 * @param {{
 *   registry: { getSpark: (id: string) => object | null },
 *   monitors: Map<string, { snapshot?: () => object }>,
 *   benchHttpTarget: (spark: object, ports: number[], body: object) => Promise<object>,
 * }} deps
 */
export function registerPlaygroundRoutes(app, deps) {
  app.get("/api/playground/providers/opencode-go/models", async (req, res) => {
    try {
      res.json(await loadOpencodeGoCatalog({ refresh: req.query.refresh === "1" }));
    } catch (err) {
      fail(res, err.status || 502, err.message || "Could not list OpenCode Go models");
    }
  });

  app.get("/api/playground/providers/opencode/models", async (req, res) => {
    try {
      res.json(await loadOpencodeCatalog({ refresh: req.query.refresh === "1" }));
    } catch (err) {
      fail(res, err.status || 502, err.message || "Could not list OpenCode models");
    }
  });

  app.get("/api/playground/providers/openrouter/models", async (req, res) => {
    try {
      res.json(await loadOpenRouterCatalog({ refresh: req.query.refresh === "1" }));
    } catch (err) {
      fail(res, err.status || 502, err.message || "Could not list OpenRouter models");
    }
  });

  app.get("/api/sparks/:id/playground/session", async (req, res) => {
    const spark = loadSpark(deps.registry, req, res);
    if (!spark) return;
    const ac = disconnectController(res);
    let opened = null;
    try {
      opened = await openTarget(deps, spark, targetInput(req), ac.signal);
      const ctx = await readEngineContext({
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        backend: opened.backend,
        modelId: opened.modelId,
        signal: ac.signal,
      });
      if (res.writableEnded) return;
      res.json({
        modelId: ctx.modelId,
        backend: ctx.backend,
        via: opened.via,
        controls: ctx.controls,
      });
    } catch (err) {
      if (ac.signal.aborted || res.writableEnded) return;
      fail(res, err.status || 500, err.message || "Could not read the LLM");
    } finally {
      opened?.close();
    }
  });

  app.get("/api/sparks/:id/playground/generation-defaults", async (req, res) => {
    const spark = loadSpark(deps.registry, req, res);
    if (!spark) return;
    const ac = disconnectController(res);
    let opened = null;
    try {
      opened = await openTarget(deps, spark, targetInput(req), ac.signal);
      const defaults = await loadGenerationDefaults({
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        backend: opened.backend,
        modelId: opened.modelId,
        signal: ac.signal,
      });
      if (res.writableEnded) return;
      res.json(defaults);
    } catch (err) {
      if (ac.signal.aborted || res.writableEnded) return;
      fail(res, err.status || 500, err.message || "Could not read generation defaults");
    } finally {
      opened?.close();
    }
  });

  app.post("/api/sparks/:id/playground/chat", async (req, res) => {
    await streamRoute(req, res, deps, { replay: false });
  });

  app.post("/api/sparks/:id/playground/stream", async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const hosted = payload.provider === "opencode-go"
      ? handleOpencodeGoStream
      : payload.provider === "opencode"
        ? handleOpencodeStream
        : payload.provider === "openrouter"
          ? handleOpenRouterStream
          : null;
    if (hosted) {
      const ac = disconnectController(res);
      try {
        await hosted({ res, body: payload, signal: ac.signal });
      } catch (err) {
        if (ac.signal.aborted || res.headersSent || res.writableEnded) {
          if (!res.writableEnded) {
            try { res.end(); } catch { /* the browser already left */ }
          }
          return;
        }
        fail(res, err.status || 500, err.message || "Playground request failed");
      }
      return;
    }
    if (typeof payload.provider === "string" && payload.provider) {
      fail(res, 400, "Unknown provider");
      return;
    }
    const spark = loadSpark(deps.registry, req, res);
    if (!spark) return;
    const ac = disconnectController(res);
    let opened = null;
    try {
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      opened = await openTarget(deps, spark, payload, ac.signal);
      const ctx = await readEngineContext({
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        backend: opened.backend,
        modelId: opened.modelId,
        signal: ac.signal,
      });
      await proxyChatStream({
        res,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        engine: ctx.backend,
        modelId: ctx.modelId,
        body: payload,
        signal: ac.signal,
      });
    } catch (err) {
      if (ac.signal.aborted || res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          try { res.end(); } catch { /* the browser already left */ }
        }
        return;
      }
      fail(res, err.status || 500, err.message || "Playground request failed");
    } finally {
      opened?.close();
    }
  });

  app.post("/api/sparks/:id/playground/replay", async (req, res) => {
    await streamRoute(req, res, deps, { replay: true });
  });
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {object} deps
 * @param {{ replay: boolean }} mode
 */
async function streamRoute(req, res, deps, mode) {
  const spark = loadSpark(deps.registry, req, res);
  if (!spark) return;
  const ac = disconnectController(res);
  let opened = null;
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const sourceMessages = mode.replay ? messagesForReplay(payload.messages) : payload.messages;
    const concurrency = mode.replay ? parseConcurrency(payload.concurrency) : 1;
    opened = await openTarget(deps, spark, payload, ac.signal);
    const ctx = await readEngineContext({
      baseUrl: opened.baseUrl,
      apiKey: opened.apiKey,
      backend: opened.backend,
      modelId: opened.modelId,
      signal: ac.signal,
    });
    const body = buildChatBody({
      modelId: ctx.modelId,
      messages: sourceMessages,
      sampling: payload.sampling,
      tools: payload.tools,
      accepted: ctx.controls,
    });
    const thinkingChoice = payload.sampling?.thinking;
    const thinkingOn = thinkingChoice === "on" || thinkingChoice === true;
    const thinkingSet = thinkingOn || thinkingChoice === "off" || thinkingChoice === false;
    const retryThinking = thinkingSet && ctx.controls?.thinking?.enabled !== false;
    if (ac.signal.aborted) return;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const runs = Array.from({ length: concurrency }, (_, index) =>
      streamChat(opened.baseUrl, body, ac.signal, {
        apiKey: opened.apiKey,
        retryThinking,
        thinkingOn,
        onState: (state) => {
          writeEvent(res, {
            type: "delta",
            index,
            content: state.content,
            reasoning: state.reasoning,
            toolCalls: state.toolCalls,
          });
        },
      }).then((result) => {
        writeEvent(res, {
          type: "done",
          index,
          error: ac.signal.aborted ? null : result.error,
          finishReason: result.finishReason,
          model: result.model,
          aborted: ac.signal.aborted,
        });
      })
    );
    await Promise.all(runs);
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (ac.signal.aborted) {
      if (!res.writableEnded) {
        if (res.headersSent) {
          writeEvent(res, { type: "done", aborted: true, error: null });
          res.end();
        }
      }
      return;
    }
    if (res.headersSent) {
      writeEvent(res, { type: "done", error: err.message || "Playground request failed", aborted: false });
      if (!res.writableEnded) res.end();
      return;
    }
    fail(res, err.status || 500, err.message || "Playground request failed");
  } finally {
    opened?.close();
  }
}
