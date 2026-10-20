import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chunksFromOpencodeEvent,
  isOpencodeFreeTier,
  promptFromMessages,
  streamOpencodeCli,
} from "../opencodeCli.js";

test("free tier is the -free id or a zero price", () => {
  assert.equal(isOpencodeFreeTier("deepseek-v4.1-flash-free"), true);
  assert.equal(isOpencodeFreeTier("deepseek-v4.1-flash"), false);
  assert.equal(isOpencodeFreeTier("custom", [{ id: "custom", cost: { input: 0, output: 0 } }]), true);
  assert.equal(isOpencodeFreeTier("paid", [{ id: "paid", cost: { input: 0.15, output: 0.6 } }]), false);
});

test("a single user message stays the prompt", () => {
  assert.equal(promptFromMessages([{ role: "user", content: "Reply with ok" }]), "Reply with ok");
  assert.match(promptFromMessages([
    { role: "system", content: "Be brief" },
    { role: "user", content: "Hi" },
  ]), /System: Be brief\n\nUser: Hi/);
});

test("json events become content without repeating a streamed part", () => {
  const streamed = new Set();
  const deltas = chunksFromOpencodeEvent({ type: "part_delta", partID: "p1", partType: "text", delta: "ok" }, streamed);
  assert.equal(deltas[0].choices[0].delta.content, "ok");
  const full = chunksFromOpencodeEvent({ type: "text", part: { id: "p1", text: "ok" } }, streamed);
  assert.equal(full.length, 0);
  const reasoning = chunksFromOpencodeEvent({ type: "reasoning", part: { id: "r1", text: "hmm" } }, streamed);
  assert.equal(reasoning[0].choices[0].delta.reasoning_content, "hmm");
});

test("the CLI stream writes the model text as server-sent events", async () => {
  const chunks = [];
  const res = {
    status() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(line) { chunks.push(line); },
    end() {},
  };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", `${JSON.stringify({ type: "text", part: { id: "t1", text: "ok" } })}\n`);
      child.emit("close", 0);
    });
    return child;
  };
  await streamOpencodeCli({
    res,
    modelId: "deepseek-v4.1-flash-free",
    body: { messages: [{ role: "user", content: "hi" }] },
    signal: new AbortController().signal,
    env: { OPENCODE_BIN: "/tmp/opencode" },
    spawnImpl,
  });
  const text = chunks.join("");
  assert.match(text, /"content":"ok"/);
  assert.match(text, /data: \[DONE\]/);
});
