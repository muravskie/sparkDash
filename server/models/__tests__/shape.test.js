import { test } from "node:test";
import assert from "node:assert/strict";
import { enginesFromRegistryText, shapeModels } from "../shape.js";

const none = new Map();

test("a shared port does not stamp the live probe onto every registry profile", () => {
  const probes = [{ port: 8000, available: true, backend: "tensorfold", engineVersion: "zig-db28187", modelId: "Qwen3.8-Flash-Next" }];
  const rows = shapeModels({
    models: [
      { id: "qwen3.8-flash-next", inference_endpoint: "http://spark.local:8000/v1", runtime: "exited", engine: "vLLM 0.30.0" },
      { id: "qwen3.8-flash-next-tensorfold", inference_endpoint: "http://spark.local:8000/v1", runtime: "running", engine: "TensorFold zig-db28187" },
    ],
  }, probes, "spark.local", none);
  assert.equal(rows.find((row) => row.id === "qwen3.8-flash-next").engine, "vLLM 0.30.0");
  assert.equal(rows.find((row) => row.id === "qwen3.8-flash-next-tensorfold").engine, "TensorFold zig-db28187");
});

test("a registry row without an engine stays blank even while that port answers", () => {
  const rows = shapeModels({
    models: [{ id: "qwen3.8-flash-next", inference_endpoint: "http://spark.local:8000/v1", runtime: "exited" }],
  }, [{ port: 8000, available: true, backend: "tensorfold", modelId: "Qwen3.8-Flash-Next" }], "", none);
  assert.equal(rows[0].engine, null);
});

test("an external monitor keeps the probe engine and version", () => {
  const rows = shapeModels({ models: [] }, [
    { port: 8000, available: true, backend: "tensorfold", engineVersion: "zig-db28187", modelId: "Qwen3.8-Flash-Next" },
  ], "spark.local", none);
  assert.equal(rows[0].id, "external:8000");
  assert.equal(rows[0].engine, "tensorfold zig-db28187");
});

test("a registry file names a profile the controller status has not started labeling", () => {
  const known = enginesFromRegistryText(`
- id: qwen3.8-flash-next
  engine: vLLM 0.30.0
- id: qwen3.8-flash-next-tensorfold
  engine: TensorFold zig-db28187
`);
  const rows = shapeModels({
    models: [
      { id: "qwen3.8-flash-next", inference_endpoint: "http://spark.local:8000/v1", runtime: "exited" },
      { id: "qwen3.8-flash-next-tensorfold", inference_endpoint: "http://spark.local:8000/v1", runtime: "running" },
    ],
  }, [{ port: 8000, available: true, backend: "tensorfold", modelId: "Qwen3.8-Flash-Next" }], "", known);
  assert.equal(rows[0].engine, "vLLM 0.30.0");
  assert.equal(rows[1].engine, "TensorFold zig-db28187");
});
