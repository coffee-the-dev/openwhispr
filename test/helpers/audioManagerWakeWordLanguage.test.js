const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadAudioManager(t) {
  const { window } = installBrowserGlobals(t, {
    initialStorage: { agentName: "Jarvis" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
  t.after(() => {
    delete globalThis.__wakeWordSettings;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-wake-language-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__wakeWordSettings;
        export const selectResolvedLLMConfig = () => ({ mode: "local", model: "cleanup-model" });
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
          reachable: false,
          model: "",
          displayProvider: "none",
          config: {},
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "agent prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    setSettings: (settings) => {
      globalThis.__wakeWordSettings = settings;
    },
    createManager: () =>
      Object.assign(Object.create(AudioManager.prototype), {
        voiceAgentRequested: false,
        translationRequested: false,
        isDictionaryEcho: () => false,
        getWhisperPrompt: () => null,
        assertAgentAllowedByPolicy: () => {},
        processAgentCommand: async () => "agent output",
        processWithReasoningModel: async () => "cleanup output",
        isReasoningAvailable: async () => true,
        finalizeChineseScript: async (text) => text,
      }),
    createBankingManager: () =>
      Object.assign(Object.create(AudioManager.prototype), {
        voiceAgentRequested: false,
        translationRequested: false,
        isProcessing: true,
        pendingAssistantConversation: null,
        pendingSelectionEdit: null,
        pendingCleanupFailure: null,
        selectionCapturePromise: null,
        isDictionaryEcho: () => false,
        getWhisperPrompt: () => null,
        assertAgentAllowedByPolicy: () => {},
        consumeAssistantSelectionContext: () => null,
        consumeSelectionCapture: async () => null,
        processWithReasoningModel: async () => "cleanup output",
        isReasoningAvailable: async () => true,
        finalizeChineseScript: async (text) => text,
      }),
  };
}

test("local analytics save uses the propagated occurrence time", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  let recordedEvent;

  setSettings({
    dataRetentionEnabled: true,
    audioRetentionDays: 0,
    customDictionary: [],
    snippets: [],
  });
  window.electronAPI.recordAnalyticsEvent = async (event) => {
    recordedEvent = event;
  };
  window.electronAPI.saveTranscription = async () => ({});

  await createManager().saveTranscription("same event", "same event", {
    clientTranscriptionId: "event-1",
    analyticsOccurredAt,
  });

  assert.equal(recordedEvent.occurredAt, analyticsOccurredAt);
});

test("generic auto-language routing infers Arabic before an English UI fallback", async (t) => {
  const { setSettings, createBankingManager } = await loadAudioManager(t);
  setSettings({
    preferredLanguage: "auto",
    uiLanguage: "en",
    useCleanupModel: true,
    cleanupDisableThinking: false,
    customDictionary: [],
    snippets: [],
  });
  localStorage.setItem("agentName", "Max");

  const manager = createBankingManager();
  await manager.processTranscriptionCore("يا Max، لخّص هذه الملاحظة", "local");

  assert.equal(manager.pendingAssistantConversation?.transcript, "لخّص هذه الملاحظة");
});

// Snippet triggers are phrases the user reserves for expansion, and they are
// free to start one with the agent's own name ("jarvis review"). Routing runs
// on the raw transcript — expansion happens later, in the renderer — so without
// trigger-aware detection the wake-word scan reads the leading name as an
// address and sends an ordinary dictation to the agent.
const snippetSettings = {
  preferredLanguage: "en",
  useCleanupModel: true,
  cleanupCloudMode: "byok",
  cleanupDisableThinking: false,
  customDictionary: [],
  snippets: [{ trigger: "jarvis review", replacement: "Review the PR below." }],
};

test("a name inside a snippet trigger does not route to the agent", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t);

  setSettings(snippetSettings);

  const result = await createManager().processTranscription("jarvis review this PR", "local");

  assert.equal(result, "cleanup output");
});

test("a real address still routes to the agent when a trigger is also spoken", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t);

  setSettings(snippetSettings);

  const result = await createManager().processTranscription(
    "Hey Jarvis, run jarvis review on PR 5",
    "local"
  );

  assert.equal(result, "agent output");
});

test("the banked agent command drops the address, not the snippet trigger", async (t) => {
  const { setSettings, createBankingManager } = await loadAudioManager(t);

  setSettings(snippetSettings);

  const manager = createBankingManager();
  await manager.processTranscription("jarvis review. Jarvis summarize it", "local");

  assert.equal(manager.pendingAssistantConversation?.transcript, "jarvis review. summarize it");
});

// Routing and stripping are separated by the selection-capture await. Re-reading
// the store there lets a snippet edit — a Control Panel save, the assistant's
// update_snippets tool, the startup SQLite sync — land between them, so the
// address is spliced out of a different reading of the transcript than the one
// that chose the route.
test("a snippets edit between routing and stripping cannot desync them", async (t) => {
  const { setSettings, createBankingManager } = await loadAudioManager(t);

  setSettings(snippetSettings);

  const manager = createBankingManager();
  manager.consumeSelectionCapture = async () => {
    setSettings({ ...snippetSettings, snippets: [] });
    return null;
  };
  await manager.processTranscription("jarvis review. Jarvis summarize it", "local");

  assert.equal(manager.pendingAssistantConversation?.transcript, "jarvis review. summarize it");
});
