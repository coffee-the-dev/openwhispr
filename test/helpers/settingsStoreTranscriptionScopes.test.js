const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("unset upload/meeting local providers inherit dictation, and onboarding mirrors them", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      localTranscriptionProvider: "nvidia",
      parakeetModel: "parakeet-tdt-0.6b-v3",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-provider-inherit-test-",
  });
  const {
    useSettingsStore,
    selectResolvedUploadTranscription,
    selectResolvedMeetingTranscription,
  } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  await t.test("a missing scoped key inherits the dictation local provider", () => {
    assert.equal(state().localTranscriptionProvider, "nvidia");
    assert.equal(state().uploadLocalTranscriptionProvider, "nvidia");
    assert.equal(state().meetingLocalTranscriptionProvider, "nvidia");
    assert.equal(selectResolvedUploadTranscription(state()).localTranscriptionProvider, "nvidia");
    assert.equal(selectResolvedMeetingTranscription(state()).localTranscriptionProvider, "nvidia");
  });

  await t.test(
    "setTranscriptionModeForAllScopes writes the dictation local provider into upload and meeting",
    () => {
      state().setLocalTranscriptionProvider("cohere");
      state().setTranscriptionModeForAllScopes("local");
      assert.equal(state().uploadLocalTranscriptionProvider, "cohere");
      assert.equal(state().meetingLocalTranscriptionProvider, "cohere");
      assert.equal(localStorage.getItem("uploadLocalTranscriptionProvider"), "cohere");
      assert.equal(localStorage.getItem("meetingLocalTranscriptionProvider"), "cohere");
      for (const [mode, useLocal] of [
        ["transcriptionMode", "useLocalWhisper"],
        ["uploadTranscriptionMode", "uploadUseLocalWhisper"],
        ["meetingTranscriptionMode", "meetingUseLocalWhisper"],
      ]) {
        assert.equal(state()[mode], "local", mode);
        assert.equal(state()[useLocal], true, useLocal);
      }
    }
  );
});

test("a self-hosted choice points dictation and upload at the server; meeting stays local", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      meetingTranscriptionMode: "local",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-self-hosted-all-scopes-test-",
  });
  const {
    useSettingsStore,
    selectResolvedUploadTranscription,
    selectResolvedMeetingTranscription,
  } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  state().setRemoteTranscriptionUrl("http://192.168.1.20:8000/v1");
  state().setRemoteTranscriptionModel("whisper-1");
  state().setTranscriptionModeForAllScopes("self-hosted");

  assert.equal(state().transcriptionMode, "self-hosted");
  assert.equal(state().useLocalWhisper, false);
  assert.equal(state().uploadTranscriptionMode, "self-hosted");
  assert.equal(state().uploadUseLocalWhisper, false);
  assert.deepEqual(
    {
      url: selectResolvedUploadTranscription(state()).remoteTranscriptionUrl,
      model: selectResolvedUploadTranscription(state()).remoteTranscriptionModel,
    },
    { url: "http://192.168.1.20:8000/v1", model: "whisper-1" }
  );
  assert.equal(state().meetingTranscriptionMode, "self-hosted");
  assert.equal(state().meetingUseLocalWhisper, false);
  const meeting = selectResolvedMeetingTranscription(state());
  assert.deepEqual(
    { url: meeting.remoteTranscriptionUrl, model: meeting.remoteTranscriptionModel },
    { url: "http://192.168.1.20:8000/v1", model: "whisper-1" }
  );

  // A Note Recording server of its own carries its own model.
  state().setMeetingRemoteTranscriptionUrl("https://whisper.example.lan/v1");
  state().setMeetingRemoteTranscriptionModel("");
  const own = selectResolvedMeetingTranscription(state());
  assert.deepEqual(
    { url: own.remoteTranscriptionUrl, model: own.remoteTranscriptionModel },
    { url: "https://whisper.example.lan/v1", model: "" }
  );
});

test("stored transcription modes read as local unless self-hosted was chosen", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      _localOnlyModesMigrated: "1",
      uploadTranscriptionMigrated: "true",
      transcriptionMode: "providers",
      uploadTranscriptionMode: "self-hosted",
      meetingTranscriptionMode: "openwhispr",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-mode-read-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();

  assert.equal(state.transcriptionMode, "local");
  assert.equal(state.uploadTranscriptionMode, "self-hosted");
  assert.equal(state.meetingTranscriptionMode, "local");
});

test("cloud and third-party transcription settings are removed at startup", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
      cloudTranscriptionMode: "byok",
      meetingCloudTranscriptionProvider: "assemblyai",
      uploadCloudTranscriptionBaseUrl: "https://api.openai.com/v1",
      transcriptionModelByProvider: JSON.stringify({ "dictation:groq": "whisper-large-v3" }),
      assemblyAiStreaming: "true",
      allowOpenAIFallback: "true",
      cortiTenant: "base",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retired-transcription-keys-test-",
  });
  await vite.ssrLoadModule("/stores/settingsStore.ts");

  for (const key of [
    "cloudTranscriptionProvider",
    "cloudTranscriptionModel",
    "cloudTranscriptionMode",
    "meetingCloudTranscriptionProvider",
    "uploadCloudTranscriptionBaseUrl",
    "transcriptionModelByProvider",
    "assemblyAiStreaming",
    "allowOpenAIFallback",
    "cortiTenant",
  ]) {
    assert.equal(localStorage.getItem(key), null, key);
  }
});
