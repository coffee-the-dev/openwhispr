const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/reasoningRouting.js");

test("fan-out routes a local provider, model and mode to all five scopes", async () => {
  const { buildReasoningScopePatches, REASONING_SCOPES } = await load();
  const patches = buildReasoningScopePatches({
    mode: "local",
    provider: "qwen",
    model: "qwen3.5-9b-q4_k_m",
  });

  assert.deepEqual(Object.keys(patches).sort(), [...REASONING_SCOPES].sort());
  for (const patch of Object.values(patches)) {
    assert.deepEqual(patch, { mode: "local", provider: "qwen", model: "qwen3.5-9b-q4_k_m" });
  }
});

// A self-hosted endpoint is only reachable from a scope that carries its url
// and key; mirroring the model alone left four scopes pointing at a
// "self-hosted" mode with no host behind it.
test("fan-out mirrors the endpoint url and key alongside the routing", async () => {
  const { buildReasoningScopePatches } = await load();
  const { dictationCleanup, dictationAgent } = buildReasoningScopePatches({
    mode: "self-hosted",
    model: "qwen3.8-flash-next",
    remoteUrl: "https://vllm.lan/v1",
    customApiKey: "secret",
  });

  for (const patch of [dictationCleanup, dictationAgent]) {
    assert.deepEqual(patch, {
      mode: "self-hosted",
      provider: "lan",
      model: "qwen3.8-flash-next",
      remoteUrl: "https://vllm.lan/v1",
      customApiKey: "secret",
    });
  }
});

test("fan-out with partial settings only mirrors the provided fields", async () => {
  const { buildReasoningScopePatches } = await load();
  const { chatIntelligence } = buildReasoningScopePatches({ mode: "local" });
  assert.deepEqual(chatIntelligence, { mode: "local" });
});

test("a scope inherits the fallback key when it inherits the endpoint", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "self-hosted" }, "self-hosted"), true);
});

test("a scope on its own remote url keeps its own key", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(
    inheritsFallbackEndpoint(
      { mode: "self-hosted", remoteUrl: "http://host:8080/v1" },
      "self-hosted"
    ),
    false
  );
});

test("a differing mode never borrows the key (regression: key sent to the wrong host)", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "local" }, "self-hosted"), false);
});

test("no fallback scope means nothing to inherit", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "self-hosted" }, undefined), false);
});
