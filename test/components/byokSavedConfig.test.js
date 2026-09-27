const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { mountByokStep } = require("../lib/byokStepHarness");

// Restarting onboarding (#2128) drops the session draft, so these steps mount with no
// resumeState and have to reopen on what the user already saved.

const PLACEHOLDER = {
  endpoint: "onboarding.rehaul.provider.endpointPlaceholder",
  selfHostedKey: "onboarding.rehaul.provider.optional",
  modelId: "onboarding.rehaul.provider.modelIdPlaceholder",
  hostedKey: "onboarding.rehaul.provider.apiKeyPlaceholder",
};
const SELF_HOSTED = {
  useLocalWhisper: "false",
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "parasail-whisper",
};
const HOSTED_ASSISTANT = {
  chatAgentMode: "providers",
  chatAgentProvider: "anthropic",
  chatAgentModel: "claude-sonnet-5",
};

// The route helper is pure, so it loads straight through tsx like its own tests do.
const loadTranscriptionRoute = () => import("../../src/helpers/transcriptionRoute.ts");

async function routeAfterOnboardingSave(step) {
  // OnboardingFlow's byok-dictation continue runs this fan-out after the step saves.
  await React.act(async () => step.state().setTranscriptionModeForAllScopes("self-hosted"));
  const { resolveTranscriptionRoute } = await loadTranscriptionRoute();
  return resolveTranscriptionRoute({ settings: step.state() });
}

// As UploadAudioView hands it to the file transcription route: the upload scope.
async function uploadRoute(step) {
  const { selectResolvedUploadTranscription } = await step.vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { resolveTranscriptionRoute } = await loadTranscriptionRoute();
  return resolveTranscriptionRoute({
    settings: selectResolvedUploadTranscription(step.state()),
  });
}

test("dictation opens the self-hosted card from either tile, with no hosted providers", async (t) => {
  for (const selfHostedRequested of [false, true]) {
    await t.test(String(selfHostedRequested), async (t) => {
      const step = await mountByokStep(t, { selfHostedRequested });
      assert.equal(step.value(PLACEHOLDER.endpoint), "");
      assert.equal(step.value(PLACEHOLDER.modelId), "");
      assert.deepEqual(step.selectValues(), []);
    });
  }
});

test("a saved self-hosted server reopens with its key, and the draft stays key-free", async (t) => {
  const step = await mountByokStep(t, {
    settings: SELF_HOSTED,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
  });

  assert.equal(step.value(PLACEHOLDER.endpoint), "https://stt.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "parasail-whisper");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");

  const drafts = await step.unmountForDrafts();
  assert.deepEqual(drafts.at(-1), {
    selectedProvider: "",
    selectedModel: "",
    baseUrl: "https://stt.example.com/v1",
    customModel: "parasail-whisper",
  });
  assert.doesNotMatch(JSON.stringify(drafts), /sk-custom-key/);
});

test("a first setup ignores a leftover key and saves the typed server", async (t) => {
  const step = await mountByokStep(t, {
    // Local dictation: nothing to reopen on, but an abandoned setup left its key behind.
    // Offering it would send it to the endpoint the user is about to type.
    settings: { useLocalWhisper: "true", transcriptionMode: "local" },
    secrets: { customTranscriptionApiKey: "sk-abandoned-key" },
    selfHostedRequested: true,
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

  await step.type(PLACEHOLDER.endpoint, "typed.example.com/v1");
  await step.type(PLACEHOLDER.modelId, "whisper-proxy-test");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.remoteTranscriptionUrl, "https://typed.example.com/v1");
  assert.equal(state.remoteTranscriptionModel, "whisper-proxy-test");
  assert.equal(state.remoteTranscriptionType, "openai-compatible");
  assert.equal(state.customTranscriptionApiKey, "", "the abandoned key is not carried over");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.transport, "http-batch");
  assert.equal(route.endpoint, "https://typed.example.com/v1/audio/transcriptions");
  assert.equal(route.model, "whisper-proxy-test");

  const upload = await uploadRoute(step);
  assert.equal(upload.transport, "http-batch");
  assert.equal(upload.model, "whisper-proxy-test");
});

test("a server saved with a key stores it for the self-hosted route", async (t) => {
  const step = await mountByokStep(t, { selfHostedRequested: true });
  await step.type(PLACEHOLDER.endpoint, "https://proxy.example.com/v1");
  await step.type(PLACEHOLDER.selfHostedKey, "sk-proxy-key");
  await step.type(PLACEHOLDER.modelId, "proxy-whisper");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.remoteTranscriptionUrl, "https://proxy.example.com/v1");
  assert.equal(state.customTranscriptionApiKey, "sk-proxy-key");
  assert.equal(state.remoteTranscriptionModel, "proxy-whisper");
  assert.equal((await routeAfterOnboardingSave(step)).transport, "http-batch");
});

test("the prefilled key follows the endpoint it was saved under", async (t) => {
  const mountSavedEndpoint = (t) =>
    mountByokStep(t, {
      settings: SELF_HOSTED,
      secrets: { customTranscriptionApiKey: "sk-custom-key" },
    });

  await t.test("retyping the endpoint takes the prefilled key back out", async (t) => {
    const step = await mountSavedEndpoint(t);
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");

    await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

    // The same server written another way is still that server.
    await step.type(PLACEHOLDER.endpoint, "stt.example.com/v1/");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
  });

  await t.test("a key the user typed survives the endpoint change", async (t) => {
    const step = await mountSavedEndpoint(t);
    await step.type(PLACEHOLDER.selfHostedKey, "sk-typed-key");
    await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-typed-key");
  });
});

test("a draft that names another server reopens key-less", async (t) => {
  const step = await mountByokStep(t, {
    settings: SELF_HOSTED,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
    // Edited earlier this session and never committed, so the stored key still belongs to
    // the saved server, not to the one the card now shows.
    resumeState: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "https://draft.example.com/v1",
      customModel: "draft-model",
    },
  });
  assert.equal(step.value(PLACEHOLDER.endpoint), "https://draft.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "draft-model");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("a blank draft falls back to the saved server", async (t) => {
  const step = await mountByokStep(t, {
    settings: SELF_HOSTED,
    resumeState: { selectedProvider: "", selectedModel: "", baseUrl: "", customModel: "" },
  });
  assert.equal(step.value(PLACEHOLDER.endpoint), "https://stt.example.com/v1");
});

test("the saved key still matches an endpoint typed with a differently cased host", async (t) => {
  const step = await mountByokStep(t, {
    settings: SELF_HOSTED,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
    resumeState: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "HTTPS://STT.Example.com/v1/",
      customModel: "parasail-whisper",
    },
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
});

test("a key that loads after mount fills an empty field but never replaces typed input", async (t) => {
  await t.test("empty field", async (t) => {
    const step = await mountByokStep(t, { settings: SELF_HOSTED });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-late-key");
  });

  await t.test("typed field", async (t) => {
    const step = await mountByokStep(t, { settings: SELF_HOSTED });
    await step.type(PLACEHOLDER.selfHostedKey, "sk-typed-key");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-typed-key");
  });
});

test("a saved assistant endpoint reopens with its key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    selfHostedRequested: true,
    settings: {
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: "http://127.0.0.1:1234/v1",
      chatAgentModel: "llm-proxy-test",
    },
    secrets: { chatAgentCustomApiKey: "sk-agent-key" },
  });

  assert.equal(step.value(PLACEHOLDER.endpoint), "http://127.0.0.1:1234/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "llm-proxy-test");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-agent-key");
});

test("a saved hosted assistant provider reopens with its model and key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: HOSTED_ASSISTANT,
    secrets: { anthropicApiKey: "sk-ant-saved-key" },
  });

  assert.deepEqual(step.selectValues(), ["anthropic", "claude-sonnet-5"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "sk-ant-saved-key");
});

test("a self-hosted assistant setup ignores a leftover agent key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    // Saved as a hosted provider, so the abandoned self-hosted key is not this
    // endpoint's: offering it would send it to the server the user is about to type.
    settings: HOSTED_ASSISTANT,
    secrets: { chatAgentCustomApiKey: "sk-abandoned-agent-key" },
  });
  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

  // Secrets hydrate over IPC, so a key arriving after mount must stay out too.
  await step.setStore({ chatAgentCustomApiKey: "sk-late-agent-key" });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("an assistant endpoint the user retyped never takes the saved agent key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    selfHostedRequested: true,
    settings: {
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: "http://127.0.0.1:1234/v1",
      chatAgentModel: "llm-proxy-test",
    },
  });

  await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
  // Secrets hydrate over IPC, so the saved key can land after the endpoint was retyped.
  await step.setStore({ chatAgentCustomApiKey: "sk-agent-key" });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("a self-hosted assistant opens self-hosted from the BYOK tile", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    selfHostedRequested: false,
    settings: {
      chatAgentMode: "self-hosted",
      chatAgentProvider: "custom",
      chatAgentRemoteUrl: "http://10.0.0.7:8080/v1",
      chatAgentModel: "qwen3-8b",
    },
  });
  assert.equal(step.value(PLACEHOLDER.endpoint), "http://10.0.0.7:8080/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "qwen3-8b");
  assert.deepEqual(step.selfHostedChanges, [true]);
});

test("switching assistant modes keeps both halves of the form and swaps only the key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: HOSTED_ASSISTANT,
    secrets: { anthropicApiKey: "sk-ant-saved-key", chatAgentCustomApiKey: "sk-agent-key" },
  });
  assert.equal(step.value(PLACEHOLDER.hostedKey), "sk-ant-saved-key");

  await step.toggleSelfHosted();
  // What is saved is a hosted provider, so the stored custom key is not this endpoint's.
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
  await step.type(PLACEHOLDER.endpoint, "https://typed.example.com/v1");

  await step.toggleSelfHosted();
  assert.deepEqual(step.selectValues(), ["anthropic", "claude-sonnet-5"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "sk-ant-saved-key");

  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.endpoint), "https://typed.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});
