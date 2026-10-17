import { randomBytes } from "crypto";
import { ActionError, SourceError } from "./errors.js";
import { hasUnfinishedTransaction, shapeModels } from "./shape.js";

const MAX_RECORDS = 50;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * In-memory dashboard switches. They survive a browser disconnect for the
 * life of this process. One active switch per Spark.
 */
export class Operations {
  /**
   * @param {{ status: Function, transactions: Function, action: Function }} client
   */
  constructor(client) {
    this.client = client;
    this.sparks = new Map();
  }

  bucket(sparkId) {
    let bucket = this.sparks.get(sparkId);
    if (!bucket) {
      bucket = { records: new Map(), active: null, tail: Promise.resolve(), pending: new Set() };
      this.sparks.set(sparkId, bucket);
    }
    return bucket;
  }

  enqueue(sparkId, fn) {
    const bucket = this.bucket(sparkId);
    const run = bucket.tail.then(fn, fn);
    bucket.tail = run.then(() => {}, () => {});
    return run;
  }

  /**
   * @param {object} spark
   * @param {string} modelId
   * @param {"activate" | "deactivate"} action
   */
  start(spark, modelId, action) {
    return this.enqueue(spark.id, async () => {
      const bucket = this.bucket(spark.id);
      if (bucket.active) {
        throw httpError(409, "Another dashboard action is in progress or has an unresolved outcome");
      }
      const status = await this.client.status(spark);
      const models = shapeModels(status);
      const model = models.find((row) => row.id === modelId);
      if (!model || model.registered === false) {
        throw httpError(404, "Model is not registered with the installed controller");
      }
      if (model.ownership === "external" || model.ownership === "external-monitor") {
        throw httpError(409, "Workload is externally owned; lifecycle takeover is not allowed");
      }
      if (action === "activate" && model.enabled === false) {
        throw httpError(409, "Model is disabled in the controller registry");
      }
      const journal = await this.client.transactions(spark);
      if (hasUnfinishedTransaction(journal?.transactions)) {
        throw httpError(409, "Controller has an unfinished transaction; review controller activity before switching");
      }
      const id = randomBytes(12).toString("hex");
      const record = {
        id,
        model_id: modelId,
        action,
        state: "working",
        started_at: new Date().toISOString(),
        finished_at: null,
        result: null,
        error: null,
        acknowledged: false,
      };
      bucket.records.set(id, record);
      while (bucket.records.size > MAX_RECORDS) {
        const oldest = bucket.records.keys().next().value;
        bucket.records.delete(oldest);
      }
      bucket.active = id;
      const task = this.execute(spark, record, bucket);
      bucket.pending.add(task);
      task.finally(() => bucket.pending.delete(task));
      return record;
    });
  }

  async execute(spark, record, bucket) {
    try {
      record.result = await this.client.action(spark, record.model_id, record.action);
      record.state = "succeeded";
    } catch (err) {
      if (err instanceof ActionError) {
        record.state = "failed";
        record.error = err.message;
      } else if (err instanceof SourceError) {
        record.state = "unknown";
        record.error = err.message;
      } else {
        record.state = "unknown";
        record.error = "Controller outcome unknown; review controller transactions";
      }
    } finally {
      record.finished_at = new Date().toISOString();
      if (record.state === "succeeded" || record.state === "failed") bucket.active = null;
    }
  }

  list(sparkId) {
    const bucket = this.bucket(sparkId);
    return {
      active: bucket.active,
      operations: [...bucket.records.values()].reverse(),
    };
  }

  /**
   * @param {object} spark
   * @param {string} operationId
   */
  async acknowledge(spark, operationId) {
    const bucket = this.bucket(spark.id);
    const record = bucket.records.get(operationId);
    if (!record || record.state !== "unknown" || bucket.active !== operationId) {
      throw httpError(409, "Only the active unresolved operation can be acknowledged");
    }
    await this.client.status(spark);
    bucket.active = null;
    record.acknowledged = true;
    return record;
  }

  /** Test helper: wait until background switches finish. */
  async drain() {
    const pending = [];
    for (const bucket of this.sparks.values()) pending.push(...bucket.pending);
    if (pending.length) await Promise.all(pending);
  }
}
