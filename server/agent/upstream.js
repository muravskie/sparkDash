/**
 * Reach OpenCode on uba's loopback. A local unit is dialed directly. Any
 * other unit is reached through the dashboard's SSH local forward, which
 * always targets 127.0.0.1 on that machine.
 */

import { parseUpstream } from "./relay.js";

const IDLE_MS = 15_000;

/**
 * @param {{ openTunnel?: Function, env?: NodeJS.ProcessEnv }} deps
 */
export function createUpstreamLocator(deps) {
  const env = deps.env || process.env;
  const openTunnel = deps.openTunnel;
  /** @type {Map<string, { host: string, port: number, close: () => void, refs: number, timer: NodeJS.Timeout | null }>} */
  const open = new Map();
  /** @type {Map<string, Promise<{ host: string, port: number, close: () => void, refs: number, timer: NodeJS.Timeout | null }>>} */
  const pending = new Map();

  function parse() {
    return parseUpstream(env);
  }

  /**
   * @param {object} spark
   * @param {{ host: string, port: number }} upstream
   */
  async function acquire(spark, upstream) {
    if (spark?.isLocal) {
      return { host: upstream.host, port: upstream.port, release() {} };
    }
    if (typeof openTunnel !== "function") {
      throw new Error("SSH tunnel is not available");
    }
    const key = String(spark.id || "");
    let slot = open.get(key);
    if (!slot) {
      let wait = pending.get(key);
      if (!wait) {
        wait = Promise.resolve()
          .then(() => openTunnel(spark, upstream.port))
          .then((opened) => {
            const created = {
              host: opened.host,
              port: opened.port,
              close: typeof opened.close === "function" ? opened.close : () => {},
              refs: 0,
              timer: null,
            };
            if (created.host !== "127.0.0.1" && created.host !== "localhost" && created.host !== "::1") {
              created.close();
              throw new Error("SSH tunnel did not bind on loopback");
            }
            open.set(key, created);
            return created;
          })
          .finally(() => pending.delete(key));
        pending.set(key, wait);
      }
      slot = await wait;
    }
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.refs += 1;
    let released = false;
    return {
      host: slot.host === "localhost" || slot.host === "::1" ? "127.0.0.1" : slot.host,
      port: slot.port,
      release() {
        if (released) return;
        released = true;
        slot.refs -= 1;
        if (slot.refs > 0) return;
        slot.timer = setTimeout(() => {
          if (slot.refs > 0) return;
          open.delete(key);
          try {
            slot.close();
          } catch {
            /* ignore */
          }
        }, IDLE_MS);
        slot.timer.unref?.();
      },
    };
  }

  function closeAll() {
    for (const slot of open.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      try {
        slot.close();
      } catch {
        /* ignore */
      }
    }
    open.clear();
  }

  return { parse, acquire, closeAll };
}
