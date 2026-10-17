import fs from "fs";

/**
 * MODEL_CONTROLLER_KEY_FILE is a server-side path to the model-controller
 * bearer key. The file's text is trimmed and sent only as
 * `Authorization: Bearer` on the HTTP hop to that Spark's controller
 * (port 29999). The key is never written into sparks.json or settings.json
 * and is stripped from every API response. sparkDash already keeps SSH
 * passwords and LLM API keys in its encrypted secrets file; this key stays
 * in the env-named file so it is not copied into sparks.json. One file is
 * used for every Spark this process contacts. The SSH Unix-socket fallback
 * does not send the key (the socket is local and unauthenticated).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string, encoding: string) => string} [readFile]
 * @returns {string | null}
 */
export function loadControllerKey(env = process.env, readFile = fs.readFileSync) {
  const file = env.MODEL_CONTROLLER_KEY_FILE;
  if (typeof file !== "string" || !file.trim()) return null;
  try {
    const key = String(readFile(file.trim(), "utf8")).trim();
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Remove bearer material from anything we are about to send to the browser.
 * @param {unknown} value
 * @param {string | null | undefined} secret
 */
export function redactSecret(value, secret) {
  if (typeof secret !== "string" || secret.length === 0) return value;
  const walk = (item) => {
    if (typeof item === "string") return item.split(secret).join("[redacted]");
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
