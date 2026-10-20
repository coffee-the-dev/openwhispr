const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// processWithSelfHosted classifies transcription failures from the throw shapes
// a renderer fetch produces: an error Response or a TypeError.
async function loadManager(t, settings) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-provider-errors-test-",
    settingsKey: "__providerErrorsSettings",
    settings: { useLocalWhisper: false, allowLocalFallback: false, ...settings },
  });
  return loaded.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getSelfHostedApiKey: async () => "test-key",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
}

const selfHostedSettings = {
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "whisper-large-v3",
};

const recording = () => new Blob(["recording"], { type: "audio/webm" });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected processWithSelfHosted to reject");
}

test("a self-hosted 404 blames the user's server", async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));

  const error = await rejection(manager.processWithSelfHosted(recording()));

  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(error.messageKey, "providerErrors.selfHosted.unknown");
  assert.equal(error.message, "Your server returned an unexpected error.");
});

test('a direct-fetch "Failed to fetch" asks to check the key and connection', async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  const error = await rejection(manager.processWithSelfHosted(recording()));

  assert.equal(error.code, "PROVIDER_NO_RESPONSE");
  assert.equal(error.messageKey, "providerErrors.selfHosted.noResponse");
  assert.equal(error.settingsTarget, "speechToText");
  assert.equal(error.messageParams.provider, "Your server");
  assert.equal(error.surface, "transcription");
});

test("a cancelled direct fetch stays an AbortError", async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  const error = await rejection(manager.processWithSelfHosted(recording()));

  assert.equal(error.name, "AbortError");
  assert.equal(error.code, 20);
  assert.equal(error.messageKey, undefined);
});
