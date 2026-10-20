const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationTranslationInference.js");

const baseSettings = {
  useDictationTranslation: true,
  translationTargetLanguage: "es",
  translationMode: "local",
  translationProvider: "qwen",
  translationModel: "qwen3.5-9b-q4_k_m",
  translationRemoteUrl: "",
  translationCustomApiKey: "",
  translationDisableThinking: true,
  translationReasoningEffort: "low",
};

test("local mode routes to llama.cpp with its translation settings", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference(baseSettings);

  assert.equal(result.reachable, true);
  assert.equal(result.model, "qwen3.5-9b-q4_k_m");
  assert.equal(result.config.provider, "local");
  assert.equal(result.config.language, "es");
  assert.equal(result.config.disableThinking, true);
  assert.equal(result.config.reasoningEffort, "low");
  assert.equal(result.config.inferenceScope, "dictationTranslation");
  assert.equal(result.displayProvider, "local");
});

test("local mode needs a model", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({ ...baseSettings, translationModel: "" });

  assert.equal(result.reachable, false);
});

test("self-hosted mode forwards its URL and key and needs no model", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "self-hosted",
    translationModel: "",
    translationRemoteUrl: "https://vllm.lan/v1",
    translationCustomApiKey: "secret",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, "https://vllm.lan/v1");
  assert.equal(result.config.customApiKey, "secret");
  assert.equal(result.displayProvider, "self-hosted");
});

test("self-hosted mode without a URL is unreachable and sends no key", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "self-hosted",
    translationCustomApiKey: "secret",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.config.lanUrl, undefined);
  assert.equal(result.config.customApiKey, undefined);
});

test("translation is unreachable when disabled or without a target", async () => {
  const { resolveDictationTranslationInference } = await load();

  assert.equal(
    resolveDictationTranslationInference({ ...baseSettings, useDictationTranslation: false })
      .reachable,
    false
  );
  assert.equal(
    resolveDictationTranslationInference({ ...baseSettings, translationTargetLanguage: "" })
      .reachable,
    false
  );
});
