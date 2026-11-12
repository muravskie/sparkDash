import { describe, expect, it } from "vitest";
import { previewDocument } from "./html-preview";

describe("previewDocument", () => {
  it("keeps scripts in a full HTML document", () => {
    const source = `<!doctype html><html><head><script src="https://cdn.example/app.js"></script></head><body><script type="module">document.body.dataset.ready = "1"</script></body></html>`;
    expect(previewDocument(source)).toBe(source);
    expect(previewDocument(source)).not.toContain("script-src 'unsafe-inline'");
    expect(previewDocument(source)).not.toContain("connect-src 'none'");
  });

  it("wraps a fragment without removing its script", () => {
    const source = `<button onclick="tick()">Go</button><script>function tick(){document.body.dataset.n=1}</script>`;
    const document = previewDocument(source);
    expect(document.startsWith("<!doctype html><meta charset=\"utf-8\">")).toBe(true);
    expect(document).toContain(source);
  });
});
