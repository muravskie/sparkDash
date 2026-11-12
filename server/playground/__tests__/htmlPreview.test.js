import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerHtmlPreviewPost, registerPublicHtmlPreview, resetHtmlPreviews } from "../htmlPreview.js";

afterEach(() => resetHtmlPreviews());

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a saved preview is the HTML file itself, sandboxed off the dashboard origin", async () => {
  const app = express();
  registerPublicHtmlPreview(app);
  app.use(express.json({ limit: "2mb" }));
  registerHtmlPreviewPost(app);
  const server = await listen(app);
  try {
    const port = server.address().port;
    const id = "ab".repeat(16);
    const source = "<!doctype html><html><body><script>document.body.dataset.ready='yes'</script><p>sort</p></body></html>";
    const post = await fetch(`http://127.0.0.1:${port}/api/playground/html-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source }),
    });
    assert.equal(post.status, 204);
    const get = await fetch(`http://127.0.0.1:${port}/api/playground/html-preview/${id}`);
    const policy = get.headers.get("content-security-policy") || "";
    assert.equal(get.status, 200);
    assert.match(get.headers.get("content-type") || "", /text\/html/);
    assert.match(policy, /sandbox allow-scripts/);
    assert.doesNotMatch(policy, /allow-same-origin/);
    assert.match(policy, /unsafe-inline/);
    assert.equal(await get.text(), source);
    const missing = await fetch(`http://127.0.0.1:${port}/api/playground/html-preview/${"cd".repeat(16)}`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
