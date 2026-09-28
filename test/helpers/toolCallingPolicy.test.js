const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/toolCallingPolicy.js");

test("an unset setting defaults to On for self-hosted and Auto on-device", async () => {
  const { effectiveToolCallingSetting } = await load();
  assert.equal(effectiveToolCallingSetting("", "self-hosted"), "on");
  assert.equal(effectiveToolCallingSetting(undefined, "local"), "auto");
  assert.equal(effectiveToolCallingSetting("bogus", "self-hosted"), "on");
  assert.equal(effectiveToolCallingSetting("off", "self-hosted"), "off");
});

test("On and Off are explicit, whatever the model", async () => {
  const { resolveToolCalling } = await load();
  assert.equal(resolveToolCalling({ setting: "on", mode: "local", model: "tiny-0.5b" }), true);
  assert.equal(
    resolveToolCalling({ setting: "off", mode: "self-hosted", model: "GLM-5.3-Flash-EXL3" }),
    false
  );
  assert.equal(resolveToolCalling({ setting: "", mode: "self-hosted", model: "" }), true);
});

test("Auto keeps the size heuristic where the id names a size", async () => {
  const { resolveToolCalling } = await load();
  assert.equal(resolveToolCalling({ setting: "auto", model: "qwen3.5-9b-q4_k_m" }), true);
  assert.equal(resolveToolCalling({ setting: "auto", model: "qwen3-1.7b-q8_0" }), false);
  assert.equal(resolveToolCalling({ setting: "", mode: "local", model: "llama-3.2-3b" }), false);
});

test("Auto falls back to known tool-capable families when the id names no size", async () => {
  const { resolveToolCalling, isKnownToolCapableModel } = await load();
  assert.equal(resolveToolCalling({ setting: "auto", model: "GLM-5.3-Flash-EXL3" }), true);
  assert.equal(resolveToolCalling({ setting: "auto", model: "qwen3.8-flash-next" }), true);
  assert.equal(resolveToolCalling({ setting: "auto", model: "my-custom-model" }), false);
  assert.equal(resolveToolCalling({ setting: "auto", model: "" }), false);
  assert.equal(isKnownToolCapableModel("gpt-oss-20b"), true);
});

test("size estimates ignore digits that are not a parameter count", async () => {
  const { estimateModelSizeB } = await load();
  assert.equal(estimateModelSizeB("qwen3.5-9b-q4_k_m"), 9);
  assert.equal(estimateModelSizeB("model-1.5B"), 1.5);
  assert.equal(estimateModelSizeB("GLM-5.3-Flash-EXL3"), 0);
  assert.equal(estimateModelSizeB("phi-4-bf16"), 0);
});
