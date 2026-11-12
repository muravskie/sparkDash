/**
 * Short-lived HTML preview documents. The response is the model's file, and
 * the sandbox directive gives it an opaque origin so its scripts cannot read
 * the dashboard.
 */

import { createHostGuardMiddleware } from "../auth.js";

export const MAX_PREVIEW_LENGTH = 500_000;
const TTL_MS = 30 * 60 * 1000;
const MAX_PAGES = 30;

const CSP = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src * data: blob: 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "media-src * data: blob:",
  "connect-src * data: blob:",
  "worker-src * blob: data:",
  "frame-src * data: blob:",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/** @type {Map<string, { source: string, at: number }>} */
const pages = new Map();

function validId(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}

function sweep(now = Date.now()) {
  for (const [id, page] of pages) {
    if (now - page.at > TTL_MS) pages.delete(id);
  }
}

/**
 * @param {string} id
 * @param {string} source
 */
export function saveHtmlPreview(id, source) {
  if (!validId(id)) return { ok: false, status: 400, error: "Invalid preview id" };
  if (typeof source !== "string" || !source.trim() || source.length > MAX_PREVIEW_LENGTH) {
    return { ok: false, status: 400, error: "HTML preview is empty or exceeds the 500,000 character limit" };
  }
  const now = Date.now();
  sweep(now);
  if (!pages.has(id) && pages.size >= MAX_PAGES) {
    const oldest = [...pages.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pages.delete(oldest[0]);
  }
  pages.set(id, { source, at: now });
  return { ok: true };
}

/** @param {string} id */
export function readHtmlPreview(id) {
  if (!validId(id)) return null;
  sweep();
  return pages.get(id)?.source ?? null;
}

export function resetHtmlPreviews() {
  pages.clear();
}

/** Public GET: a normal navigation does not send the dashboard token. */
export function registerPublicHtmlPreview(app) {
  app.get("/api/playground/html-preview/:id", createHostGuardMiddleware(), (req, res) => {
    const source = readHtmlPreview(req.params.id);
    if (source == null) {
      res.status(404).type("html").send("<!doctype html><title>Preview expired</title><p>Open the preview again from the conversation.</p>");
      return;
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", CSP);
    res.type("html").send(source);
  });
}

/** Authenticated save. Register after the auth middleware. */
export function registerHtmlPreviewPost(app) {
  app.post("/api/playground/html-preview", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const saved = saveHtmlPreview(body.id, body.source);
    if (!saved.ok) {
      res.status(saved.status).json({ error: saved.error });
      return;
    }
    res.status(204).end();
  });
}
