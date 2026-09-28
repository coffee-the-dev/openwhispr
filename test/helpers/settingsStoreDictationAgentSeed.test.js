const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The assistant panel used to answer on the Chat scope while the Voice Assistant
// scope sat unconfigured (mode defaulting to cloud, empty provider and model).
// Now that the panel answers on the Voice Assistant scope, a profile that never
// configured it must inherit its Chat scope once, or a signed-in Local/BYOK chat
// user would have spoken commands move to OpenWhispr Cloud silently.
test("the Voice Assistant scope is seeded from Chat once for profiles that never configured it", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-agent-seed-test-",
  });
  const load = async (seed) => {
    storage.clear();
    storage.setItem("_localOnlyModesMigrated", "1");
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return mod.useSettingsStore.getState();
  };
  const localChat = {
    _llmScopeKeysMigrated: "1",
    chatAgentMode: "local",
    chatAgentProvider: "llama",
    chatAgentModel: "qwen3-8b",
    chatAgentCloudMode: "byok",
  };

  await t.test("a Local chat with an untouched Voice Assistant scope copies it over", async () => {
    const state = await load(localChat);
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "llama");
    assert.equal(state.dictationAgentModel, "qwen3-8b");
    assert.equal(storage.getItem("_dictationAgentSeeded"), "key-pending");
  });

  await t.test("a self-hosted chat carries its endpoint", async () => {
    const state = await load({
      ...localChat,
      chatAgentMode: "self-hosted",
      chatAgentProvider: "custom",
      chatAgentRemoteUrl: "https://llm.lan:8080/v1",
    });
    assert.equal(state.dictationAgentMode, "self-hosted");
    assert.equal(state.dictationAgentRemoteUrl, "https://llm.lan:8080/v1");
  });

  await t.test("a Voice Assistant scope the user configured is left alone", async () => {
    const state = await load({ ...localChat, dictationAgentMode: "self-hosted" });
    assert.equal(state.dictationAgentMode, "self-hosted");
    assert.equal(state.dictationAgentRemoteUrl, "");
    assert.equal(storage.getItem("_dictationAgentSeeded"), "1");
  });

  await t.test("a scope with only a provider and model written counts as configured", async () => {
    const state = await load({
      ...localChat,
      dictationAgentProvider: "gemma",
      dictationAgentModel: "gemma-4-e4b-q4_k_m",
    });
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "gemma");
    assert.equal(state.dictationAgentModel, "gemma-4-e4b-q4_k_m");
  });

  // A fresh profile's Chat scope settles on the local runtime, so the copy is a
  // no-op in effect.
  await t.test("a fresh profile inherits the local default Chat settled on", async () => {
    const state = await load({});
    assert.equal(storage.getItem("chatAgentMode"), "local");
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "");
  });

  await t.test("a seeded profile is not seeded again after Chat changes", async () => {
    const state = await load({ ...localChat, _dictationAgentSeeded: "1" });
    assert.equal(state.dictationAgentMode, "local", "settled local, not copied from Chat");
    assert.equal(state.dictationAgentModel, "", "Chat's model was not copied");
  });
});
