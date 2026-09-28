const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Pins the local-only migrations in settingsStore.ts: cloud, enterprise and
// provider selections leave OpenWhispr Cloud and third parties. Transcription
// moves once; LLM scopes are settled on every launch.
//
// The earlier one-shot migrations are seeded done so each case exercises this
// migration alone.
const EARLIER_MIGRATIONS_DONE = {
  _providerSettingsMigrated: "1",
  meetingFollowsTranscription: "false",
  meetingFollowsReasoning: "false",
  uploadTranscriptionMigrated: "true",
  uploadSelfHostedMigrated: "true",
  _agentModeMigrated: "1",
  _promptsMigrated: "1",
  _llmScopeKeysMigrated: "1",
  _dictationAgentSeeded: "1",
};

test("persisted cloud and provider modes move to local or self-hosted once", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-only-migration-test-",
  });

  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries({ ...EARLIER_MIGRATIONS_DONE, ...seed })) {
      storage.setItem(key, value);
    }
    vite.moduleGraph.invalidateAll();
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return useSettingsStore.getState();
  };

  await t.test("a fresh install reads fully local defaults", async () => {
    const state = await load({});
    assert.equal(state.transcriptionMode, "local");
    assert.equal(state.useLocalWhisper, true);
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(state.uploadTranscriptionMode, "local");
    assert.equal(state.uploadUseLocalWhisper, true);
    for (const key of [
      "cleanupMode",
      "dictationAgentMode",
      "noteFormattingMode",
      "chatAgentMode",
      "translationMode",
    ]) {
      assert.equal(state[key], "local", key);
    }
    assert.equal(state.chatAgentProvider, "");
    assert.equal(state.cleanupProvider, "");
    assert.equal(storage.getItem("_localOnlyModesMigrated"), "1");
  });

  await t.test("OpenWhispr Cloud and enterprise transcription go local", async () => {
    const state = await load({
      transcriptionMode: "openwhispr",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "openwhispr",
      uploadTranscriptionMode: "enterprise",
      uploadUseLocalWhisper: "false",
      meetingTranscriptionMode: "openwhispr",
      meetingUseLocalWhisper: "false",
    });
    assert.equal(state.transcriptionMode, "local");
    assert.equal(state.useLocalWhisper, true);
    assert.equal(state.uploadTranscriptionMode, "local");
    assert.equal(state.uploadUseLocalWhisper, true);
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(state.meetingUseLocalWhisper, true);
  });

  await t.test("a provider selection with a configured server goes self-hosted", async () => {
    const state = await load({
      transcriptionMode: "providers",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
      remoteTranscriptionUrl: "https://whisper.lan/v1",
    });
    assert.equal(state.transcriptionMode, "self-hosted");
    assert.equal(state.useLocalWhisper, false);
    assert.equal(state.remoteTranscriptionUrl, "https://whisper.lan/v1");
  });

  await t.test("a Custom provider's base URL becomes the self-hosted server", async () => {
    const state = await load({
      uploadTranscriptionMode: "providers",
      uploadUseLocalWhisper: "false",
      uploadCloudTranscriptionProvider: "custom",
      uploadCloudTranscriptionBaseUrl: "http://10.0.0.5:8000/v1",
    });
    assert.equal(state.uploadTranscriptionMode, "self-hosted");
    assert.equal(state.uploadRemoteTranscriptionUrl, "http://10.0.0.5:8000/v1");
  });

  await t.test("a provider selection with no server goes local", async () => {
    const state = await load({
      transcriptionMode: "providers",
      useLocalWhisper: "false",
      cloudTranscriptionProvider: "deepgram",
      meetingTranscriptionMode: "providers",
      meetingRemoteTranscriptionUrl: "https://whisper.lan/v1",
    });
    assert.equal(state.transcriptionMode, "local");
    assert.equal(state.useLocalWhisper, true);
    // Note Recording has no self-hosted route.
    assert.equal(state.meetingTranscriptionMode, "local");
  });

  await t.test("a cloud LLM scope goes local and forgets its cloud model", async () => {
    const state = await load({
      cleanupMode: "openwhispr",
      cleanupCloudMode: "openwhispr",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5-mini",
    });
    assert.equal(state.cleanupMode, "local");
    assert.equal(state.cleanupProvider, "");
    assert.equal(state.cleanupModel, "");
  });

  await t.test("a Custom LLM provider becomes the scope's self-hosted server", async () => {
    const state = await load({
      chatAgentMode: "providers",
      chatAgentProvider: "custom",
      chatAgentModel: "qwen3.8-flash-next",
      chatAgentCloudBaseUrl: "https://vllm.lan/v1",
    });
    assert.equal(state.chatAgentMode, "self-hosted");
    assert.equal(state.chatAgentRemoteUrl, "https://vllm.lan/v1");
    assert.equal(state.chatAgentProvider, "lan");
    assert.equal(state.chatAgentModel, "qwen3.8-flash-next");
  });

  await t.test("an existing local or self-hosted choice is kept", async () => {
    const state = await load({
      dictationAgentMode: "local",
      dictationAgentProvider: "qwen",
      dictationAgentModel: "qwen3.5-9b-q4_k_m",
      translationMode: "self-hosted",
      translationRemoteUrl: "https://vllm.lan/v1",
      translationModel: "qwen3.8-flash-next",
    });
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "qwen");
    assert.equal(state.dictationAgentModel, "qwen3.5-9b-q4_k_m");
    assert.equal(state.translationMode, "self-hosted");
    assert.equal(state.translationModel, "qwen3.8-flash-next");
  });

  await t.test("note formatting that follows cleanup keeps following it", async () => {
    const state = await load({
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupModel: "qwen3.8-flash-next",
      cleanupCloudBaseUrl: "https://vllm.lan/v1",
    });
    assert.equal(state.cleanupMode, "self-hosted");
    assert.equal(state.noteFormattingMode, "self-hosted");
    assert.equal(state.noteFormattingProvider, "");
    assert.equal(state.noteFormattingModel, "");
  });

  await t.test("retired account, sync and enterprise settings are dropped", async () => {
    const retired = {
      enterpriseSetupMode: "auto",
      isSignedIn: "true",
      cloudBackupEnabled: "true",
      activeWorkspaceId: "workspace-1",
      "lastSyncedAt.notes": "2026-01-01T00:00:00.000Z",
      "workspaces.joinPromptDismissed.user-1": "[]",
      "leaderboardLeavePending:user-1": '{"attempts":1}',
    };
    await load(retired);
    for (const key of Object.keys(retired)) assert.equal(storage.getItem(key), null, key);
  });

  await t.test("a provider picked after the transcription move is settled too", async () => {
    const state = await load({
      _localOnlyModesMigrated: "1",
      dictationAgentMode: "providers",
      dictationAgentProvider: "anthropic",
      dictationAgentModel: "claude-sonnet-4-6",
      translationMode: "providers",
      translationProvider: "openai",
      translationRemoteUrl: "https://vllm.lan/v1",
    });
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "");
    assert.equal(state.dictationAgentModel, "");
    assert.equal(state.translationMode, "self-hosted");
    assert.equal(state.translationProvider, "lan");
    assert.equal(storage.getItem("dictationAgentCloudMode"), null);
  });

  await t.test("a Custom provider left on OpenAI's default base is not adopted", async () => {
    const state = await load({
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupCloudBaseUrl: "https://api.openai.com/v1",
    });
    assert.equal(state.cleanupMode, "local");
    assert.equal(state.cleanupRemoteUrl, "");
  });

  await t.test("a local scope forgets a provider the local catalog does not own", async () => {
    const state = await load({
      chatAgentMode: "local",
      chatAgentProvider: "groq",
      chatAgentModel: "llama-3.3-70b-versatile",
    });
    assert.equal(state.chatAgentMode, "local");
    assert.equal(state.chatAgentProvider, "");
    assert.equal(state.chatAgentModel, "");
  });

  await t.test("the transcription migration runs once", async () => {
    const state = await load({
      _localOnlyModesMigrated: "1",
      transcriptionMode: "providers",
      useLocalWhisper: "false",
    });
    assert.equal(localStorage.getItem("transcriptionMode"), "providers", "not rewritten");
    // The store reads any mode but self-hosted as local.
    assert.equal(state.transcriptionMode, "local");
  });
});
