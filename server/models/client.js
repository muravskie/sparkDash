import { isAllowedTargetHost } from "../validate.js";
import { ActionError, ControllerAbsent, SourceError } from "./errors.js";
import { redactSecret } from "./key.js";

export const CONTROLLER_PORT = 29999;
export const CONTROLLER_SOCKET = "/run/spark-model-controller/controller.sock";

const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * @param {unknown} err
 */
export function errorCode(err) {
  const cause = err && typeof err === "object" ? err.cause : null;
  const code = (cause && cause.code) || err?.code;
  return typeof code === "string" ? code : "";
}

/**
 * @param {unknown} err
 */
export function failedBeforeSend(err) {
  return BEFORE_SEND.has(errorCode(err));
}

/**
 * @param {unknown} err
 */
export function isTimeout(err) {
  const name = err && typeof err === "object" ? err.name : "";
  return name === "TimeoutError" || name === "AbortError" || errorCode(err) === "ETIMEDOUT";
}

/**
 * @param {string} message
 */
export function socketMissing(message) {
  return /no such file|couldn't connect|failed to connect|connection refused|curl: \(7\)|curl: \(6\)/i.test(String(message || ""));
}

/**
 * curl prints the body, then a status line. sshExec trims the trailing newline.
 * @param {string} stdout
 */
export function parseCurlResult(stdout) {
  const text = String(stdout ?? "").trim();
  const match = text.match(/^(?:([\s\S]*?)\n)?(\d{3})$/);
  if (!match) return { status: 0, body: null };
  let body = null;
  if (match[1]) {
    try {
      body = JSON.parse(match[1]);
    } catch {
      body = null;
    }
  }
  return { status: Number(match[2]), body };
}

/**
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @param {object | undefined} body
 * @param {number} timeoutSec
 */
export function socketCommand(method, path, body, timeoutSec) {
  if (method !== "GET" && method !== "POST") throw new Error("refusing controller method");
  if (!/^\/v1\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*(?:\?[A-Za-z0-9._~%=&-]*)?$/.test(path)) {
    throw new Error("refusing controller path");
  }
  const seconds = Number.isInteger(timeoutSec) && timeoutSec > 0 ? timeoutSec : 8;
  const data = body == null ? "" : ` -H 'Content-Type: application/json' --data ${shellSingle(JSON.stringify(body))}`;
  return `curl -sS -m ${seconds} --unix-socket ${CONTROLLER_SOCKET} -w '\\n%{http_code}' -X ${method}${data} http://localhost${path}`;
}

function shellSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {string | null} key
 * @param {boolean} isAction
 */
export function interpretControllerResponse(status, body, key, isAction) {
  const payload = body && typeof body === "object" ? body : null;
  const message = redactSecret(
    typeof payload?.error === "string" && payload.error ? payload.error : "Controller request failed",
    key
  );
  if (status >= 500) {
    throw new SourceError("Controller reported a server error; outcome unknown. Review status and transactions before retrying.");
  }
  if (status === 401 || status === 403) {
    throw new ActionError(status, "Controller refused the dashboard key");
  }
  if (status >= 400) {
    throw new ActionError(status, typeof message === "string" ? message : "Controller request failed");
  }
  if (!payload) throw new SourceError("Controller returned an unreadable response");
  if (isAction) {
    if (typeof payload.transaction_id !== "string" || (payload.status !== "active" && payload.status !== "inactive")) {
      throw new SourceError("Controller response lost; outcome is unknown. Review controller status and transactions before retrying.");
    }
    return { transaction_id: payload.transaction_id, status: payload.status };
  }
  return payload;
}

/**
 * The controller HTTP listener is on the Spark's LAN address, not the
 * loopback address some local LLM engines use. Prefer lanIp, then the SSH
 * host the dashboard already uses to reach the unit.
 * @param {object | null | undefined} spark
 */
export function controllerHost(spark) {
  const lan = spark?.lanIp != null ? String(spark.lanIp).trim() : "";
  const sshHost = spark?.ssh?.host != null ? String(spark.ssh.host).trim() : "";
  const host = lan || sshHost || (spark?.isLocal ? "127.0.0.1" : "");
  if (!host || !isAllowedTargetHost(host)) return "";
  return host;
}

/**
 * @param {{ key?: () => string | null, sshExec?: Function, fetchImpl?: typeof fetch, httpRequest?: Function, sshRequest?: Function }} opts
 */
export function createControllerClient(opts = {}) {
  const getKey = typeof opts.key === "function" ? opts.key : () => opts.key ?? null;
  const fetchImpl = opts.fetchImpl || fetch;

  async function httpRequest(spark, method, path, body, timeoutMs) {
    if (opts.httpRequest) return opts.httpRequest(spark, method, path, body, timeoutMs);
    const host = controllerHost(spark);
    if (!host) throw new ControllerAbsent();
    const key = getKey();
    const headers = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const literalHost = host.includes(":") ? `[${host}]` : host;
    try {
      const response = await fetchImpl(`http://${literalHost}:${CONTROLLER_PORT}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: response.status, body: parsed };
    } catch (err) {
      if (failedBeforeSend(err) || isTimeout(err)) {
        const unreachable = new Error("controller port unreachable");
        unreachable.code = "UNREACHABLE";
        unreachable.beforeSend = failedBeforeSend(err);
        unreachable.timedOut = isTimeout(err) && !failedBeforeSend(err);
        throw unreachable;
      }
      throw new SourceError("Controller response lost; outcome is unknown. Review controller status and transactions before retrying.");
    }
  }

  async function sshRequest(spark, method, path, body, timeoutMs) {
    if (opts.sshRequest) return opts.sshRequest(spark, method, path, body, timeoutMs);
    if (typeof opts.sshExec !== "function") throw new ControllerAbsent();
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    let stdout;
    try {
      stdout = await opts.sshExec(spark, socketCommand(method, path, body, timeoutSec), { timeoutMs: timeoutMs + 2000 });
    } catch (err) {
      if (socketMissing(err?.message)) throw new ControllerAbsent();
      throw new SourceError("Controller response lost; outcome is unknown. Review controller status and transactions before retrying.");
    }
    return parseCurlResult(stdout);
  }

  /**
   * @param {object} spark
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {object} [body]
   * @param {{ ssh?: boolean, timeoutMs?: number }} [options]
   */
  async function request(spark, method, path, body, options = {}) {
    const isAction = method === "POST";
    const timeoutMs = options.timeoutMs ?? (isAction ? 30 * 60 * 1000 : 4000);
    const key = getKey();
    let result;
    try {
      result = await httpRequest(spark, method, path, body, timeoutMs);
    } catch (err) {
      if (err instanceof SourceError || err instanceof ActionError || err instanceof ControllerAbsent) throw err;
      const before = Boolean(err?.beforeSend) || failedBeforeSend(err);
      const timedOut = Boolean(err?.timedOut) || (isTimeout(err) && !before);
      const unreachable = err?.code === "UNREACHABLE" || before || timedOut;
      // A POST that timed out may have reached the controller. Do not send it again.
      if (isAction && timedOut && !before) {
        throw new SourceError("Controller response lost; outcome is unknown. Review controller status and transactions before retrying.");
      }
      if (!unreachable) throw err;
      if (options.ssh === false || (isAction && !before)) throw new ControllerAbsent();
      try {
        result = await sshRequest(spark, method, path, body, method === "GET" ? 8000 : timeoutMs);
      } catch (sshErr) {
        if (sshErr instanceof ControllerAbsent || sshErr instanceof SourceError || sshErr instanceof ActionError) throw sshErr;
        throw new ControllerAbsent();
      }
    }
    return interpretControllerResponse(result.status, result.body, key, isAction);
  }

  return {
    request,
    async status(spark, options) {
      const body = await request(spark, "GET", "/v1/status", undefined, options);
      if (!Array.isArray(body?.models) || !body.models.every((model) => model && typeof model.id === "string")) {
        throw new SourceError("Controller returned an invalid models contract");
      }
      return body;
    },
    async transactions(spark, options) {
      const body = await request(spark, "GET", "/v1/transactions?limit=50", undefined, options);
      const transactions = Array.isArray(body?.transactions) ? body.transactions : [];
      return { transactions };
    },
    async action(spark, modelId, action) {
      if (action !== "activate" && action !== "deactivate") throw new ActionError(404, "Unknown lifecycle action");
      return request(spark, "POST", `/v1/models/${encodeURIComponent(modelId)}/${action}`, {});
    },
  };
}
