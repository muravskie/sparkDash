/**
 * Free-tier OpenCode models refuse a direct API call. Those ids go through
 * the OpenCode CLI (`opencode run`), which is the client the free tier accepts.
 * Paid OpenCode models stay on the HTTP API.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} message
 * @param {number} status
 */
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * @param {string} modelId
 * @param {readonly { id: string, cost?: { input?: number, output?: number, cache_read?: number, cache_write?: number } | null }[] | null | undefined} [catalog]
 */
export function isOpencodeFreeTier(modelId, catalog) {
  if (typeof modelId !== "string" || !modelId) return false;
  if (/-free$/i.test(modelId)) return true;
  const row = Array.isArray(catalog) ? catalog.find((model) => model.id === modelId) : null;
  const cost = row?.cost;
  if (!cost) return false;
  return cost.input === 0 && cost.output === 0 && !(cost.cache_read > 0) && !(cost.cache_write > 0);
}

/**
 * @param {unknown[]} messages
 */
export function promptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw fail("messages are required", 400);
  /** @type {string[]} */
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    const text = messageText(message.content);
    if (!text) continue;
    if (messages.length === 1 && role === "user") return text;
    const label = role === "system" ? "System" : role === "assistant" ? "Assistant" : role === "tool" ? "Tool" : "User";
    parts.push(`${label}: ${text}`);
  }
  if (!parts.length) throw fail("messages are required", 400);
  return parts.join("\n\n");
}

/**
 * @param {unknown} content
 */
function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    return "";
  }).join("").trim();
}

/**
 * Translate one `opencode run --format json` event into OpenAI chunks.
 * A full text part is skipped when its deltas were already streamed.
 *
 * @param {object} event
 * @param {Set<string>} streamed
 * @returns {object[]}
 */
export function chunksFromOpencodeEvent(event, streamed) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "part_delta" && typeof event.delta === "string" && event.delta) {
    if (typeof event.partID === "string") streamed.add(event.partID);
    const field = event.partType === "reasoning" ? "reasoning_content" : "content";
    return [{ choices: [{ delta: { [field]: event.delta }, finish_reason: null }] }];
  }
  if ((event.type === "text" || event.type === "reasoning") && event.part && typeof event.part.text === "string") {
    if (typeof event.part.id === "string" && streamed.has(event.part.id)) return [];
    if (!event.part.text) return [];
    if (typeof event.part.id === "string") streamed.add(event.part.id);
    const field = event.type === "reasoning" ? "reasoning_content" : "content";
    return [{ choices: [{ delta: { [field]: event.part.text }, finish_reason: null }] }];
  }
  if (event.type === "error") {
    const message = typeof event.error === "string"
      ? event.error
      : event.error?.data?.message || event.error?.message || "OpenCode request failed";
    return [{ error: { message: String(message) } }];
  }
  return [];
}

/**
 * The dashboard container sees the host filesystem read-only, so the CLI
 * runs in the host mount namespace as the user who owns the OpenCode login.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {typeof fs} [io]
 */
export function opencodeCliLaunch(env = process.env, io = fs) {
  const configured = typeof env.OPENCODE_BIN === "string" ? env.OPENCODE_BIN.trim() : "";
  if (configured) return { command: configured, args: [], env, cwd: undefined };
  const root = typeof env.HOST_ROOT_PATH === "string" ? env.HOST_ROOT_PATH.trim() : "";
  if (root) {
    let names = [];
    try {
      names = io.readdirSync(path.join(root, "home"));
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const mountedHome = path.join(root, "home", name);
      const mountedBin = path.join(mountedHome, ".opencode", "bin", "opencode");
      if (!io.existsSync(mountedBin)) continue;
      let uid = 0;
      let gid = 0;
      try {
        const st = io.statSync(mountedHome);
        uid = st.uid;
        gid = st.gid;
      } catch {
        continue;
      }
      const hostHome = path.join("/home", name);
      return {
        command: "nsenter",
        args: ["-t", "1", "-m", "-W", hostHome, "--setuid", String(uid), "--setgid", String(gid), "--", path.join(hostHome, ".opencode", "bin", "opencode")],
        env: { ...env, HOME: hostHome, USER: name, LOGNAME: name },
        cwd: undefined,
      };
    }
  }
  return { command: "opencode", args: [], env, cwd: undefined };
}

/**
 * @param {import("express").Response} res
 * @param {object} payload
 */
function writeChunk(res, payload) {
  if (payload === "[DONE]") {
    res.write("data: [DONE]\n\n");
    return;
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * @param {{
 *   res: import("express").Response,
 *   modelId: string,
 *   body: object,
 *   signal: AbortSignal,
 *   env?: NodeJS.ProcessEnv,
 *   spawnImpl?: typeof spawn,
 * }} opts
 */
export async function streamOpencodeCli(opts) {
  const payload = opts.body && typeof opts.body === "object" ? opts.body : {};
  const prompt = promptFromMessages(Array.isArray(payload.messages) ? payload.messages : []);
  const launch = opencodeCliLaunch(opts.env || process.env);
  const args = [
    ...launch.args,
    "run",
    "--standalone",
    "--format", "json",
    "--log-level", "error",
    "--thinking",
    "--model", `opencode/${opts.modelId}`,
    "--",
    prompt,
  ];
  const spawnImpl = opts.spawnImpl || spawn;
  const child = spawnImpl(launch.command, args, {
    env: launch.env,
    cwd: launch.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const streamed = new Set();
  let stderr = "";
  let sawText = false;
  let failed = false;
  opts.res.status(200);
  opts.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  opts.res.setHeader("Cache-Control", "no-store");
  opts.res.setHeader("X-Accel-Buffering", "no");
  if (typeof opts.res.flushHeaders === "function") opts.res.flushHeaders();

  const onAbort = () => {
    child.kill("SIGTERM");
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  let pending = "";
  child.stdout?.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const piece of chunksFromOpencodeEvent(event, streamed)) {
        if (piece.error) failed = true;
        else if (piece.choices?.[0]?.delta?.content) sawText = true;
        writeChunk(opts.res, piece);
      }
    }
  });

  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", resolve);
  });
  opts.signal?.removeEventListener("abort", onAbort);
  if (opts.signal?.aborted) return;
  if (!sawText && (failed || code !== 0)) {
    const detail = stderr.trim().split("\n").filter(Boolean).pop() || `OpenCode CLI exited ${code}`;
    writeChunk(opts.res, { error: { message: detail.slice(0, 500) } });
  } else if (sawText) {
    writeChunk(opts.res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  writeChunk(opts.res, "[DONE]");
  opts.res.end();
}
