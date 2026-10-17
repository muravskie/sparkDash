import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTurn, reduceStreamDelta } from "../deltas.js";

test("reduceStreamDelta joins text, prefers reasoning over reasoning_content, and merges tool-call fragments", () => {
  let state = emptyTurn();
  state = reduceStreamDelta(state, {
    choices: [{ delta: { reasoning: "plan", reasoning_content: "ignore this duplicate" } }],
  });
  state = reduceStreamDelta(state, {
    choices: [{ delta: { content: "Hel" } }],
  });
  state = reduceStreamDelta(state, {
    choices: [{ delta: { content: "lo", reasoning_content: " more" } }],
  });
  state = reduceStreamDelta(state, {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "" } }],
      },
    }],
  });
  state = reduceStreamDelta(state, {
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: "{\"q\":" } },
          { index: 1, id: "call_2", function: { name: "other", arguments: "{}" } },
        ],
      },
    }],
  });
  state = reduceStreamDelta(state, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
  });

  assert.equal(state.content, "Hello");
  assert.equal(state.reasoning, "plan more");
  assert.deepEqual(state.toolCalls, [
    { index: 0, id: "call_1", name: "lookup", arguments: "{\"q\":1}" },
    { index: 1, id: "call_2", name: "other", arguments: "{}" },
  ]);
});

test("reduceStreamDelta uses choice.text when the chunk has no content delta", () => {
  const state = reduceStreamDelta(emptyTurn(), { choices: [{ text: "plain" }] });
  assert.equal(state.content, "plain");
  assert.equal(state.reasoning, "");
  assert.deepEqual(state.toolCalls, []);
});

test("reduceStreamDelta ignores non-objects and does not mutate the previous turn", () => {
  const start = emptyTurn();
  const next = reduceStreamDelta(start, null);
  assert.notEqual(next, start);
  assert.equal(next.content, "");
  const withText = reduceStreamDelta(start, { choices: [{ delta: { content: "a" } }] });
  const again = reduceStreamDelta(withText, { choices: [] });
  assert.equal(withText.content, "a");
  assert.equal(again.content, "a");
  assert.notEqual(again.toolCalls, withText.toolCalls);
});
