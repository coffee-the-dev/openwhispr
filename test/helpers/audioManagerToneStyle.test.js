const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "hey are you around this evening thinking coffee around six";

// Tone & Style classifies the dictation's app at recording start and the
// cleanup request carries the tone picked for that kind of app.
test("dictation cleanup carries the tone for the app it was captured in", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-tone-style-",
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
    cleanupModel: "test-model",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
    toneStyleEnabled: true,
    toneStyles: { personal: "very_casual", work: "casual", email: "excited", other: "formal" },
  });
  let capturedCategory;
  window.electronAPI.captureDictationAppCategory = async () => capturedCategory;
  const configs = [];
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
      processWithReasoningModel: async (_text, _model, _agentName, config) => {
        configs.push(config);
        return "Thanks so much for today!";
      },
    });
  const lastConfig = () => configs[configs.length - 1];

  await t.test(
    "local and self-hosted cleanup get the tone through the reasoning config",
    async () => {
      capturedCategory = "email";
      const manager = createManager();
      manager.beginToneStyleCapture();
      await manager.processTranscription(RAW, "local");
      assert.deepEqual(lastConfig().toneStyle, { appCategory: "email", tone: "excited" });
      assert.equal(lastConfig().inferenceScope, "dictationCleanup");
    }
  );

  await t.test("an app the classifier can't place gets the other-apps tone", async () => {
    capturedCategory = null;
    const manager = createManager();
    manager.beginToneStyleCapture();
    await manager.processTranscription(RAW, "local");
    assert.deepEqual(lastConfig().toneStyle, { appCategory: "other", tone: "formal" });
  });

  await t.test("no tone without a capture, or once Tone & Style is off", async () => {
    capturedCategory = "email";
    await createManager().processTranscription(RAW, "local");
    assert.equal(lastConfig().toneStyle, null);

    const manager = createManager();
    manager.beginToneStyleCapture();
    useSettingsStore.setState({ toneStyleEnabled: false });
    await manager.processTranscription(RAW, "local");
    useSettingsStore.setState({ toneStyleEnabled: true });
    assert.equal(lastConfig().toneStyle, null);
  });

  await t.test("an app classified after 1.5 s of speech still gets its tone", async (st) => {
    st.mock.timers.enable({ apis: ["setTimeout"] });
    let classify;
    capturedCategory = new Promise((resolve) => (classify = resolve));
    const manager = createManager();
    manager.beginToneStyleCapture();
    st.mock.timers.tick(1600);
    classify("email");
    assert.deepEqual(await manager.consumeToneStyle(), { appCategory: "email", tone: "excited" });
  });

  await t.test("a new recording drops the previous recording's capture", async () => {
    capturedCategory = "work";
    const manager = createManager();
    manager.beginToneStyleCapture();
    manager.setVoiceAgentRequested(false);
    assert.equal(await manager.consumeToneStyle(), null);
  });
});
