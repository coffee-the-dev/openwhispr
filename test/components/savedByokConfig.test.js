const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/savedByokConfig.ts");
const DRAFT_KEYS = ["baseUrl", "customModel", "selectedModel", "selectedProvider"];

// A fresh install: only store defaults, nothing the user configured.
const firstRun = async () => ({
  transcriptionMode: "local",
  remoteTranscriptionUrl: "",
  remoteTranscriptionModel: "",
  chatAgentMode: "openwhispr",
  chatAgentProvider: "groq",
  chatAgentModel: "openai/gpt-oss-120b",
  chatAgentRemoteUrl: "",
});

test("a first run has nothing to reopen", async () => {
  const { resolveSavedByokConfig } = await load();
  const settings = await firstRun();
  assert.equal(resolveSavedByokConfig("byok-dictation", settings), null);
  assert.equal(resolveSavedByokConfig("byok-assistant", settings), null);
});

test("local dictation reopens nothing, even with a saved server URL", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    remoteTranscriptionUrl: "http://192.168.1.5:8178",
    remoteTranscriptionModel: "large-v3",
  });
  assert.equal(saved, null);
});

test("the self-hosted server reopens as an endpoint carrying the custom key", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: " http://192.168.1.5:8178 ",
    remoteTranscriptionModel: "large-v3",
  });
  assert.deepEqual(saved, {
    draft: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "http://192.168.1.5:8178",
      customModel: "large-v3",
    },
    usesCustomKey: true,
  });
});

test("self-hosted mode without a URL reopens nothing", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    transcriptionMode: "self-hosted",
  });
  assert.equal(saved, null);
});

test("the assistant reopens its self-hosted endpoint or hosted provider", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();

  assert.deepEqual(
    resolveSavedByokConfig("byok-assistant", {
      ...base,
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: " http://127.0.0.1:1234/v1 ",
      chatAgentModel: "llm-proxy-test",
    }),
    {
      draft: {
        selectedProvider: "",
        selectedModel: "",
        baseUrl: "http://127.0.0.1:1234/v1",
        customModel: "llm-proxy-test",
      },
      // The assistant's only self-hosted route sends chatAgentCustomApiKey.
      usesCustomKey: true,
    }
  );
  assert.deepEqual(
    resolveSavedByokConfig("byok-assistant", {
      ...base,
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-sonnet-5",
    }),
    {
      draft: {
        selectedProvider: "anthropic",
        selectedModel: "claude-sonnet-5",
        baseUrl: "",
        customModel: "",
      },
      usesCustomKey: false,
    }
  );
});

test("the assistant reopens nothing it could not save back", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const settings of [
    { ...base, chatAgentMode: "self-hosted", chatAgentRemoteUrl: "" },
    { ...base, chatAgentMode: "providers", chatAgentProvider: "custom" },
    { ...base, chatAgentMode: "openwhispr" },
    { ...base, chatAgentMode: "local", chatAgentProvider: "qwen" },
  ]) {
    assert.equal(resolveSavedByokConfig("byok-assistant", settings), null, settings.chatAgentMode);
  }
});

test("a reopened draft only carries the four session fields", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const [stepId, settings] of [
    [
      "byok-dictation",
      { ...base, transcriptionMode: "self-hosted", remoteTranscriptionUrl: "http://x/v1" },
    ],
    [
      "byok-assistant",
      { ...base, chatAgentMode: "self-hosted", chatAgentRemoteUrl: "http://x/v1" },
    ],
  ]) {
    assert.deepEqual(
      Object.keys(resolveSavedByokConfig(stepId, settings).draft).sort(),
      DRAFT_KEYS
    );
  }
});

test("a draft is blank only when every field is empty", async () => {
  const { isBlankByokDraft } = await load();
  const blank = { selectedProvider: "", selectedModel: "", baseUrl: "", customModel: "" };
  assert.equal(isBlankByokDraft(blank), true);
  for (const field of DRAFT_KEYS) {
    assert.equal(isBlankByokDraft({ ...blank, [field]: "x" }), false, field);
  }
});
