const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const UNCONFIGURED = "hooks.audioRecording.cleanupUnconfigured";

async function loadRealAudioManager(t) {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-unconfigured-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    useCleanupModel: true,
    cleanupMode: "local",
    cleanupModel: "",
    useDictationAgent: false,
    useDictationTranslation: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
  });
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    _shownCleanupSetupKey: null,
    getEffectiveSttLanguage: () => "en",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    isReasoningAvailable: async () => true,
    finalizeChineseScript: async (text) => text,
  });
  return { window, manager, setSettings: (next) => useSettingsStore.setState(next) };
}

async function dictate(manager, text) {
  assert.equal(await manager.processTranscriptionCore(text, "local"), text);
  return manager._takePendingResultExtras().cleanupFailure;
}

test("cleanup on with no model warns once it is shown, and again after a fix breaks", async (t) => {
  const { window, manager, setSettings } = await loadRealAudioManager(t);

  const first = await dictate(manager, "hello there");
  assert.equal(first.messageKey, UNCONFIGURED);
  assert.equal(first.settingsTarget, "llms");

  // A notice that never reached the screen (a cancelled dictation) is not used up.
  assert.equal((await dictate(manager, "hello again")).messageKey, UNCONFIGURED);
  manager.markCleanupNoticeShown(first);
  assert.equal(await dictate(manager, "and again"), undefined);

  // A reachable model runs cleanup and forgets the warning, so the same broken
  // setup warns again once the model is gone.
  setSettings({ cleanupModel: "test-model" });
  window.electronAPI.processLocalReasoning = async () => ({ success: true, text: "Cleaned." });
  assert.equal(await manager.processTranscriptionCore("fixed now", "local"), "Cleaned.");
  assert.equal(manager._takePendingResultExtras().cleanupFailure, undefined);
  setSettings({ cleanupModel: "" });
  assert.equal((await dictate(manager, "broken again")).messageKey, UNCONFIGURED);

  setSettings({ useCleanupModel: false });
  assert.equal(await dictate(manager, "cleanup off"), undefined);
});

test("cleanup with nothing to run on warns even when the assistant is reachable", async (t) => {
  const { manager, setSettings } = await loadRealAudioManager(t);
  // A reachable assistant skips the early "no model" return; cleanup still can't run.
  setSettings({
    useDictationAgent: true,
    dictationAgentMode: "local",
    dictationAgentModel: "agent-model",
  });
  manager.isReasoningAvailable = async () => false;
  assert.equal((await dictate(manager, "local words")).messageKey, UNCONFIGURED);
});
