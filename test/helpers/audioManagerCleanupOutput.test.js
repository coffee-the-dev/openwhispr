const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n${CLEAN}`;
const MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupDuplicated";

test("invalid completed local cleanup keeps raw text", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-output-",
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
    cleanupProvider: "local",
    cleanupModel: "test-model",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
  });
  const createManager = () =>
    Object.assign(Object.create(AudioManager.prototype), {
      voiceAgentRequested: false,
      translationRequested: false,
      pendingCleanupFailure: null,
      getEffectiveSttLanguage: () => "en",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      isReasoningAvailable: async () => true,
      finalizeChineseScript: async (text) => text,
    });

  await t.test("local cleanup failure flows through raw fallback and persistence", async () => {
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    const manager = createManager();
    const result = await manager.processTranscriptionCore(RAW, "local");
    assert.equal(result, RAW);
    assert.equal(manager._takePendingResultExtras().cleanupFailure.messageKey, MESSAGE_KEY);
    let saved;
    window.electronAPI.recordAnalyticsEvent = async () => {};
    window.electronAPI.saveTranscription = async (text, rawText) => {
      saved = { text, rawText };
      return { success: true };
    };
    await manager.saveTranscription(result, RAW);
    assert.deepEqual(saved, { text: RAW, rawText: RAW });
  });
});
