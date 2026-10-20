const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Pin both cleanup routes against the local bridge's 0.7 default, on either runtime.
async function loadRouteResolver(t, mode = "local") {
  const { vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cleanup-route-config-test-",
    settingsKey: "__cleanupRouteConfigSettings",
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__cleanupRouteConfigSettings;
        export const selectResolvedLLMConfig = () => ({
          model: "cleanup-model",
          mode: ${JSON.stringify(mode)},
          remoteUrl: "https://vllm.lan/v1",
        });
      `,
      "/dictationAgentInference": `
        export const scopeAcceptsImages = () => false;
        export const resolveDictationAgentInference = () => ({
          reachable: true,
          model: "agent-model",
          displayProvider: "test",
          config: { provider: "test" },
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: true,
          model: "translate-model",
          displayProvider: "test",
          config: { provider: "test" },
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "route prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
        export const wrapCleanupTranscript = (text) => text;
        export const getCleanupSystemPrompt = () => "cleanup prompt";
      `,
    },
  });
  const settings = {
    useCleanupModel: true,
    cleanupDisableThinking: true,
    cleanupReasoningEffort: "medium",
  };
  const resolveReasoningRoute = (await vite.ssrLoadModule("/helpers/audioManager.js"))
    .resolveReasoningRoute;
  return (text, { voiceAgentRequested = false, translationRequested = false } = {}) =>
    resolveReasoningRoute(text, settings, "Jarvis", voiceAgentRequested, translationRequested);
}

test("the cleanup route pins temperature 0 and requires complete output", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("so um clean this up");

  assert.equal(route.kind, "cleanup");
  assert.equal(route.config.inferenceScope, "dictationCleanup");
  assert.equal(route.config.temperature, 0);
  assert.equal(route.config.requireCompleteOutput, true);
  assert.equal(route.config.reasoningEffort, "medium");
});

test("the translation chain's cleanup step pins the same config", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("so um translate this", { translationRequested: true });

  assert.equal(route.kind, "translation");
  assert.equal(route.cleanupConfig.inferenceScope, "dictationCleanup");
  assert.equal(route.cleanupConfig.temperature, 0);
  assert.equal(route.cleanupConfig.requireCompleteOutput, true);
  assert.equal(route.config.temperature, undefined);
});

test("self-hosted cleanup pins the same temperature", async (t) => {
  const resolveRoute = await loadRouteResolver(t, "self-hosted");
  assert.equal(resolveRoute("clean this").config.temperature, 0);
  assert.equal(
    resolveRoute("translate this", { translationRequested: true }).cleanupConfig.temperature,
    0
  );
});

test("the agent route keeps its provider defaults", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("Jarvis, what is on my calendar", { voiceAgentRequested: true });

  assert.equal(route.kind, "agent");
  assert.equal(route.config.temperature, undefined);
  assert.equal(route.config.requireCompleteOutput, undefined);
});
