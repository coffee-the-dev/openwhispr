const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("cleanup failure details ride the raw result instead of notifying before paste", async (t) => {
  globalThis.__cleanupFallbackImmediateNotifications = [];
  t.after(() => delete globalThis.__cleanupFallbackImmediateNotifications);

  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-fallback-",
    settingsKey: "__audioCleanupFallbackSettings",
    settings: {
      useCleanupModel: true,
      cleanupProvider: "qwen",
      cleanupMode: "local",
      cleanupDisableThinking: true,
      useDictationAgent: false,
      useDictationTranslation: false,
      preferredLanguage: "en",
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__audioCleanupFallbackSettings;
        export const selectResolvedLLMConfig = () => ({
          mode: "local",
          provider: "qwen",
          model: "qwen3.5-9b-q4_k_m"
        });
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
      "/dictationAgentInference": `
        export const scopeAcceptsImages = () => false;
        export const resolveDictationAgentInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
      `,
      "/stores/cleanupFailureStore": `
        export const recordCleanupFailure = (failure) => {
          globalThis.__cleanupFallbackImmediateNotifications.push(failure);
        };
      `,
    },
  });

  const failure = Object.assign(new Error("Model not found: qwen3.5-9b-q4_k_m"), {
    messageKey: "models.errors.localServerUnavailable",
    messageParams: { model: "qwen3.5-9b-q4_k_m" },
  });
  const manager = createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    isReasoningAvailable: async () => true,
    processWithReasoningModel: async () => {
      throw failure;
    },
  });

  const text = await manager.processTranscriptionCore("original dictation", "local");

  assert.equal(text, "original dictation");
  assert.deepEqual(globalThis.__cleanupFallbackImmediateNotifications, []);
  assert.deepEqual(manager._takePendingResultExtras(), {
    cleanupFailure: {
      message: failure.message,
      messageKey: failure.messageKey,
      messageParams: failure.messageParams,
    },
  });
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

// The chain translates the raw transcript when cleanup fails, so the dropped cleanup
// has to reach the same toast the plain cleanup route raises (#2091).
test("a truncated cleanup inside the translation chain still reports the failure", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-translation-cleanup-",
    settingsKey: "__audioTranslationCleanupSettings",
    settings: {
      useCleanupModel: true,
      cleanupProvider: "qwen",
      cleanupMode: "local",
      cleanupDisableThinking: true,
      useDictationAgent: false,
      useDictationTranslation: true,
      translationSourceLanguage: "en",
      translationTargetLanguage: "es",
      preferredLanguage: "en",
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__audioTranslationCleanupSettings;
        export const selectResolvedLLMConfig = () => ({
          mode: "local",
          provider: "qwen",
          model: "qwen3.5-9b-q4_k_m"
        });
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
      "/dictationAgentInference": `
        export const scopeAcceptsImages = () => false;
        export const resolveDictationAgentInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: true,
          model: "qwen3.5-9b-q4_k_m",
          displayProvider: "local",
          config: { provider: "local" }
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "translate prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
        export const wrapCleanupTranscript = (text) => text;
        export const getCleanupSystemPrompt = () => "cleanup prompt";
      `,
    },
  });

  const truncated = Object.assign(new Error("Model output was truncated"), {
    messageKey: "hooks.audioRecording.errorDescriptions.cleanupTruncated",
  });
  const manager = createManager({
    voiceAgentRequested: false,
    translationRequested: true,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    isReasoningAvailable: async () => true,
    notifyTranslationFallback: () => {},
    // The cleanup step is the only call in the chain that requires complete output.
    processWithReasoningModel: async (_text, _model, _agentName, config) => {
      if (config?.requireCompleteOutput) throw truncated;
      return "dictado traducido";
    },
  });

  const text = await manager.processTranscriptionCore("original dictation", "local");

  assert.equal(text, "dictado traducido");
  assert.deepEqual(manager._takePendingResultExtras(), {
    cleanupFailure: { message: truncated.message, messageKey: truncated.messageKey },
  });
});

test("safePaste reports not pasted when the preload reports that no text was pasted", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-outcome-",
    settingsKey: "__audioCleanupPasteOutcomeSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a resolved no-op is not a paste error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: false });

  assert.deepEqual(await manager.safePaste("onboarding transcript"), {
    pasted: false,
  });
});

test("safePaste reports pasted only when the preload reports a completed paste", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-success-",
    settingsKey: "__audioCleanupPasteSuccessSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a completed paste must not report an error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: true });

  assert.deepEqual(await manager.safePaste("completed transcript"), {
    pasted: true,
  });
});

// The hook tells a paste held back for still-held modifiers apart from an
// ordinary clipboard-only fallback by this reason, so it must survive safePaste.
test("safePaste passes through why a paste was held back", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-held-",
    settingsKey: "__audioCleanupPasteHeldSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a held-back paste is not a paste error"),
  });
  window.electronAPI.pasteText = async () => ({
    success: true,
    pasted: false,
    reason: "modifiers-held",
  });

  assert.deepEqual(await manager.safePaste("held transcript"), {
    pasted: false,
    reason: "modifiers-held",
  });
});

test("translation cleanup failures survive successful and skipped translation for post-paste warnings", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-translation-cleanup-warning-",
    settingsKey: "__translationCleanupWarningSettings",
  });
  const rawText = "Full first sentence. Full final sentence.";
  const failure = new Error("Gemini returned incomplete output (MAX_TOKENS)");

  for (const targetLanguage of ["en", "es"]) {
    const manager = createManager({
      pendingCleanupFailure: null,
      processWithReasoningModel: async (text, model) => {
        assert.equal(text, rawText);
        if (model === "cleanup-model") throw failure;
        assert.equal(model, "translation-model");
        assert.equal(targetLanguage, "es");
        return "Primera frase completa. Última frase completa.";
      },
      notifyTranslationFallback: () => assert.fail("translation did not fail"),
    });

    const result = await manager.runTranslationChain({
      text: rawText,
      settings: { translationSourceLanguage: "en", translationTargetLanguage: targetLanguage },
      agentName: null,
      route: {
        model: "translation-model",
        cleanupReachable: true,
        cleanupConfig: {},
        config: {},
      },
      cleanup: { mode: "model", model: "cleanup-model" },
    });

    assert.equal(
      result.text,
      targetLanguage === "en" ? rawText : "Primera frase completa. Última frase completa."
    );
    assert.equal(result.translated, targetLanguage === "es");
    assert.deepEqual(manager._takePendingResultExtras(), {
      cleanupFailure: { message: failure.message },
    });
    assert.deepEqual(manager._takePendingResultExtras(), {});
  }
});

test("a classified provider cleanup failure keeps the fields its toast needs", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-classified-cleanup-failure-",
    settingsKey: "__classifiedCleanupFailureSettings",
  });
  const failure = Object.assign(new Error("OpenAI rejected your API key."), {
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
    messageParams: { provider: "OpenAI" },
    settingsTarget: "llms",
    surface: "llm",
    technicalDetails: { provider: "OpenAI", status: 401 },
  });
  const manager = createManager({
    pendingCleanupFailure: null,
    processWithReasoningModel: async () => {
      throw failure;
    },
  });

  await manager.runTranslationChain({
    text: "raw dictation",
    settings: { translationSourceLanguage: "en", translationTargetLanguage: "en" },
    agentName: null,
    route: { model: "translation-model", cleanupReachable: true, cleanupConfig: {}, config: {} },
    cleanup: { mode: "model", model: "cleanup-model" },
  });

  assert.deepEqual(manager._takePendingResultExtras(), {
    cleanupFailure: {
      message: failure.message,
      messageKey: failure.messageKey,
      messageParams: failure.messageParams,
      surface: failure.surface,
      settingsTarget: failure.settingsTarget,
      technicalDetails: failure.technicalDetails,
    },
  });
});
