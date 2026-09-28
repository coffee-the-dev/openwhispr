const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationAgentInference.js");

const baseSettings = {
  useDictationAgent: true,
  dictationAgentMode: "local",
  dictationAgentProvider: "qwen",
  dictationAgentModel: "qwen3.5-9b-q4_k_m",
  dictationAgentRemoteUrl: "",
  dictationAgentCustomApiKey: "",
  dictationAgentDisableThinking: true,
};

test("uses the dictation agent scope, not the cleanup scope", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    // Cleanup is configured completely differently; it must not leak through.
    cleanupMode: "self-hosted",
    cleanupRemoteUrl: "https://cleanup.lan/v1",
    cleanupModel: "qwen3.8-flash-next",
  });

  assert.equal(result.model, "qwen3.5-9b-q4_k_m");
  assert.equal(result.config.provider, "local");
  assert.equal(result.config.lanUrl, undefined);
  assert.equal(result.displayProvider, "local");
});

test("a local agent is unreachable without an explicit model", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({ ...baseSettings, dictationAgentModel: "" });

  assert.equal(result.reachable, false);
});

test("self-hosted is reachable with no model and forwards the LAN url and key", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "self-hosted",
    dictationAgentModel: "",
    dictationAgentRemoteUrl: "http://127.0.0.1:8080/v1",
    dictationAgentCustomApiKey: "test-key",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, "http://127.0.0.1:8080/v1");
  assert.equal(result.config.customApiKey, "test-key");
  assert.equal(result.displayProvider, "self-hosted");
});

test("self-hosted without a server is unreachable and carries no key", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "self-hosted",
    dictationAgentCustomApiKey: "test-key",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.config.customApiKey, undefined);
});

test("the assistant toggled off is unreachable", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({ ...baseSettings, useDictationAgent: false });

  assert.equal(result.reachable, false);
});

test("thinking suppression follows the agent's own setting", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentDisableThinking: false,
  });

  assert.equal(result.config.disableThinking, false);
  assert.equal(result.config.inferenceScope, "dictationAgent");
});

// The assistant panel answers spoken commands on the Voice Assistant scope —
// the tab the user actually edits — and gates screenshots exactly like the
// dictation route does.
const imageWired = (providerId) => providerId === "lan";
const panelSettings = {
  ...baseSettings,
  chatAgentMode: "self-hosted",
  chatAgentProvider: "lan",
  chatAgentModel: "qwen3.8-flash-next",
  chatAgentRemoteUrl: "https://vllm.lan/v1",
};
const panel = (settings, options = {}) =>
  resolveChatStreamingInference(settings, {
    inferenceScope: "dictationAgent",
    isProviderImageWired: imageWired,
    ...options,
  });
let resolveChatStreamingInference;
test.before(async () => {
  ({ resolveChatStreamingInference } = await load());
});

test("typed chat surfaces stay on the Chat scope even when the Voice Assistant scope is reachable", () => {
  const { config, attachScreenContext } = resolveChatStreamingInference(panelSettings, {
    hasScreenContext: true,
    isProviderImageWired: imageWired,
  });

  assert.equal(config.scope, "chatIntelligence");
  assert.equal(config.model, "qwen3.8-flash-next");
  assert.equal(attachScreenContext, true, "Chat's own provider takes images");
});

test("an unreachable Voice Assistant scope falls the panel back to the Chat scope", () => {
  const { config, attachScreenContext } = panel(
    { ...panelSettings, dictationAgentModel: "" },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "chatIntelligence");
  assert.equal(config.remoteUrl, "https://vllm.lan/v1");
  assert.equal(attachScreenContext, true, "the fallback is gated on Chat's provider");
});

test("the assistant toggled off keeps the panel on the Chat scope", () => {
  const { config } = panel({ ...panelSettings, useDictationAgent: false });

  assert.equal(config.scope, "chatIntelligence");
});

test("the assistant panel resolves the Voice Assistant scope, not the Chat scope", () => {
  const { config, attachScreenContext } = panel(panelSettings);

  assert.equal(config.scope, "dictationAgent");
  assert.equal(config.model, "qwen3.5-9b-q4_k_m");
  assert.equal(attachScreenContext, false, "nothing to attach without a screenshot");
});

test("a screenshot is dropped when the answering provider is not image-wired", () => {
  const { config, attachScreenContext } = panel(panelSettings, { hasScreenContext: true });

  assert.equal(config.scope, "dictationAgent");
  assert.equal(attachScreenContext, false);
});
