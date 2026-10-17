import { llmProbeHost } from "../collectors/llmHost.js";
import { ControllerAbsent, SourceError } from "./errors.js";
import { createControllerClient } from "./client.js";
import { scriptGuard } from "./guard.js";
import { loadControllerKey, redactSecret } from "./key.js";
import { Operations } from "./operations.js";
import { shapeModels } from "./shape.js";

const MODEL_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const CACHE_MS = 20_000;

/**
 * @param {Map<string, { at: number, status: object }>} cache
 * @param {string} sparkId
 */
function cachedStatus(cache, sparkId) {
  const row = cache.get(sparkId);
  if (!row) return null;
  if (Date.now() - row.at > CACHE_MS) return null;
  return row.status;
}

function probesOf(monitors, sparkId) {
  const snap = monitors?.get?.(sparkId)?.snapshot?.();
  const list = snap?.metrics?.llm;
  return Array.isArray(list) ? list : [];
}

/**
 * @param {import("express").Response} res
 * @param {number} status
 * @param {unknown} body
 * @param {string | null} key
 */
function send(res, status, body, key) {
  res.status(status).json(redactSecret(body, key));
}

/**
 * @param {import("express").Express} app
 * @param {{ registry: { getSpark: (id: string) => object | null }, monitors?: Map<string, { snapshot?: () => object }>, client?: object, operations?: Operations, cache?: Map<string, { at: number, status: object }>, readKey?: () => string | null, sshExec?: Function }} deps
 */
export function registerModelRoutes(app, deps) {
  const cache = deps.cache || new Map();
  const readKey = deps.readKey || (() => loadControllerKey());
  const client = deps.client || createControllerClient({
    key: readKey,
    sshExec: deps.sshExec,
  });
  const operations = deps.operations || new Operations(client);

  function loadSpark(req, res) {
    const spark = deps.registry.getSpark(req.params.id);
    if (!spark) {
      send(res, 404, { error: "Spark not found" }, readKey());
      return null;
    }
    return spark;
  }

  async function readBoard(spark) {
    const key = readKey();
    const listed = operations.list(spark.id);
    try {
      const status = await client.status(spark);
      cache.set(spark.id, { at: Date.now(), status });
      let events = [];
      let eventsError = null;
      try {
        events = (await client.transactions(spark)).transactions;
      } catch (err) {
        eventsError = err instanceof Error ? err.message : "Controller journal unavailable";
      }
      const models = shapeModels(status, probesOf(deps.monitors, spark.id), llmProbeHost(spark));
      const launchers = deps.launchers?.list?.(spark.id) || [];
      return {
        status: 200,
        body: {
          configured: true,
          available: true,
          error: eventsError,
          models,
          active: listed.active,
          operations: listed.operations,
          events,
          scriptGuard: scriptGuard(launchers, models),
        },
        key,
      };
    } catch (err) {
      const absent = err instanceof ControllerAbsent;
      const message = err instanceof Error ? err.message : "Controller unavailable";
      const models = [];
      return {
        status: 200,
        body: {
          configured: !absent,
          available: false,
          error: absent ? null : message,
          models,
          active: listed.active,
          operations: listed.operations,
          events: [],
          scriptGuard: { hideAll: false, blockedIds: [], reason: null },
        },
        key,
      };
    }
  }

  app.get("/api/sparks/:id/models", async (req, res) => {
    const spark = loadSpark(req, res);
    if (!spark) return;
    const board = await readBoard(spark);
    send(res, board.status, board.body, board.key);
  });

  async function switchModel(req, res, action) {
    const spark = loadSpark(req, res);
    if (!spark) return;
    const modelId = req.params.modelId;
    if (typeof modelId !== "string" || !MODEL_ID.test(modelId)) {
      return send(res, 400, { error: "Unknown model id" }, readKey());
    }
    try {
      const record = await operations.start(spark, modelId, action);
      send(res, 202, record, readKey());
    } catch (err) {
      let status = Number.isInteger(err?.status) ? err.status : 503;
      if (status === 401 || status === 403) status = 503;
      send(res, status, { error: err instanceof Error ? err.message : "Controller switch failed" }, readKey());
    }
  }

  app.post("/api/sparks/:id/models/:modelId/activate", (req, res) => {
    void switchModel(req, res, "activate");
  });
  app.post("/api/sparks/:id/models/:modelId/deactivate", (req, res) => {
    void switchModel(req, res, "deactivate");
  });

  app.post("/api/sparks/:id/models/operations/:operationId/acknowledge", async (req, res) => {
    const spark = loadSpark(req, res);
    if (!spark) return;
    try {
      const record = await operations.acknowledge(spark, req.params.operationId);
      send(res, 200, record, readKey());
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 503;
      send(res, status, { error: err instanceof Error ? err.message : "Could not acknowledge" }, readKey());
    }
  });

  return { client, operations, cache, readBoard };
}

/**
 * Refuse start/stop when a fresh controller reading says this script is the
 * managed workload. HTTP only on this path, plus the status cached by the
 * models page, so a missing controller does not open an SSH session.
 *
 * @param {{ status: Function }} client
 * @param {Map<string, { at: number, status: object }>} cache
 * @param {object} spark
 * @param {{ id: string }} launcher
 * @param {object[]} launchers
 * @returns {Promise<string | null>}
 */
export async function blockScriptLaunch(client, cache, spark, launcher, launchers) {
  let status = cachedStatus(cache, spark.id);
  if (!status) {
    try {
      status = await client.status(spark, { ssh: false, timeoutMs: 800 });
      cache.set(spark.id, { at: Date.now(), status });
    } catch {
      status = cachedStatus(cache, spark.id);
    }
  }
  if (!status) return null;
  const guard = scriptGuard(launchers, shapeModels(status));
  if (guard.hideAll || guard.blockedIds.includes(launcher.id)) return guard.reason;
  return null;
}
