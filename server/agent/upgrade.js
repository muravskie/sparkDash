/**
 * WebSocket bridge for OpenCode's terminal. The dashboard's `/ws` upgrade
 * stays on the dashboard port; this handles the OpenCode embed port.
 */

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { authorizeUpgrade } from "../auth.js";
import { forwardRequestHeaders } from "./relay.js";
import { agentDenied } from "./access.js";

/**
 * @param {import("stream").Duplex} socket
 * @param {number} status
 * @param {string} message
 */
function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(JSON.stringify({ error: message }));
  const reason = http.STATUS_CODES[status] || "Error";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
  );
  socket.write(body);
  socket.destroy();
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("stream").Duplex} client
 * @param {{ host: string, port: number }} target
 * @param {string | null} auth
 * @param {string} path
 */
function bridge(req, client, target, auth, path) {
  const headers = forwardRequestHeaders(req.headers, `${target.host}:${target.port}`, auth, {});
  delete headers.Host;
  delete headers.Connection;
  delete headers.Upgrade;
  const protocols = req.headers["sec-websocket-protocol"];
  const protocolList = protocols
    ? String(protocols)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const upstream = protocolList.length
    ? new WebSocket(`ws://${target.host}:${target.port}${path}`, protocolList, { headers, handshakeTimeout: 5000 })
    : new WebSocket(`ws://${target.host}:${target.port}${path}`, { headers, handshakeTimeout: 5000 });
  /** @type {{ data: import("ws").RawData, isBinary: boolean }[]} */
  const queued = [];
  const closeBoth = () => {
    try {
      if (client.readyState === WebSocket.OPEN) client.close();
    } catch {
      /* ignore */
    }
    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    } catch {
      /* ignore */
    }
  };
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else queued.push({ data, isBinary });
  });
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("open", () => {
    for (const item of queued) upstream.send(item.data, { binary: item.isBinary });
    queued.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", closeBoth);
  upstream.on("error", closeBoth);
}

/**
 * @param {{ resolve: (req: import("http").IncomingMessage) => Promise<{ target: { host: string, port: number, release: () => void }, auth: string | null, path: string } | { error: string, status: number }> }} sessions
 */
export function createAgentUpgrade(sessions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  wss.on("error", () => {});
  return function onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    if (!authorizeUpgrade(req, { agentCookie: true })) {
      rejectUpgrade(socket, 401, "Authentication required");
      return;
    }
    const denied = agentDenied(req, { upgrade: true, agentCookie: true });
    if (denied) {
      rejectUpgrade(socket, denied.status, denied.error);
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on("error", () => {});
      void sessions
        .resolve(req)
        .then((result) => {
          if (!result || "error" in result) {
            client.close(1011, String(result?.error || "OpenCode on uba is not reachable").slice(0, 120));
            return;
          }
          const release = () => result.target.release();
          client.on("close", release);
          try {
            bridge(req, client, result.target, result.auth, result.path);
          } catch {
            release();
            client.close(1011, "OpenCode on uba is not reachable");
          }
        })
        .catch(() => {
          client.close(1011, "OpenCode on uba is not reachable");
        });
    });
  };
}
