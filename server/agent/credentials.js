/**
 * Copyright (c) 2026 hasso5703. Adapted under the MIT license.
 *
 * Reads the OpenCode basic-auth file the way the Cockpit agent relay reads
 * server credentials. This is a new Node implementation.
 */

import fs from "node:fs";

const USER_KEY = "OPENCODE_USERNAME";
const PASSWORD_KEY = "OPENCODE_PASSWORD";

/**
 * @param {string} value
 */
function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} value
 */
function headerSafe(value) {
  return value.length > 0 && !/[\r\n]/.test(value);
}

/**
 * @param {string} text
 * @returns {{ username: string, password: string } | null}
 */
function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const password = data.password;
  if (typeof password !== "string" || !headerSafe(password)) return null;
  const username = data.username;
  const user = typeof username === "string" && headerSafe(username) ? username : "opencode";
  return { username: user, password };
}

/**
 * @param {string} text
 * @returns {{ username: string, password: string } | null}
 */
function parseLines(text) {
  /** @type {Record<string, string>} */
  const kv = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    kv[key] = value;
  }
  const password = kv[PASSWORD_KEY] || "";
  if (!headerSafe(password)) return null;
  const username = kv[USER_KEY] || "opencode";
  if (!headerSafe(username)) return null;
  return { username, password };
}

/**
 * OPENCODE_CREDENTIALS_FILE is a mode-600 JSON object `{username, password}`
 * or a line file with OPENCODE_USERNAME and OPENCODE_PASSWORD. The values
 * are used only as the upstream Basic header. Callers must not put them in
 * API JSON, sparks.json, or settings.json.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ statSync?: typeof fs.statSync, readFileSync?: typeof fs.readFileSync }} [io]
 * @returns {{ credentials: { username: string, password: string } | null, error: string | null }}
 */
export function loadOpencodeCredentials(env = process.env, io = fs) {
  const file = clean(env.OPENCODE_CREDENTIALS_FILE);
  if (!file) return { credentials: null, error: "OpenCode credentials are not configured" };
  let stat;
  try {
    stat = io.statSync(file);
  } catch {
    return { credentials: null, error: "OpenCode credentials file is not readable" };
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    return { credentials: null, error: "OpenCode credentials file must be mode 600" };
  }
  let text;
  try {
    text = io.readFileSync(file, "utf8");
  } catch {
    return { credentials: null, error: "OpenCode credentials file is not readable" };
  }
  const trimmed = text.trim();
  const json = file.toLowerCase().endsWith(".json") || trimmed.startsWith("{");
  const credentials = json ? parseJson(trimmed) : parseLines(text);
  if (!credentials) return { credentials: null, error: "OpenCode credentials file is missing a password" };
  return { credentials, error: null };
}

/**
 * @param {unknown} value
 * @param {{ username?: string, password?: string } | null | undefined} creds
 */
export function redactCredentials(value, creds) {
  const secrets = [];
  if (typeof creds?.password === "string" && creds.password) secrets.push(creds.password);
  if (typeof creds?.username === "string" && creds.username.length >= 4 && creds.username !== "opencode") {
    secrets.push(creds.username);
  }
  if (!secrets.length) return value;
  const walk = (item) => {
    if (typeof item === "string") {
      let out = item;
      for (const secret of secrets) out = out.split(secret).join("[redacted]");
      return out;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out = {};
      for (const [key, child] of Object.entries(item)) out[key] = walk(child);
      return out;
    }
    return item;
  };
  return walk(value);
}
