const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadSharedAudioManager } = require("./harness/audioManager");

// Every case drives a prototype-only manager through the shared renderer
// harness; only the transcription mode and dictionary prompt differ per case.
async function loadAudioManager(t, opts) {
  const loaded = await loadSharedAudioManager(t, opts);
  return {
    ...loaded,
    createManager: (overrides = {}) =>
      loaded.createManager({
        getEffectiveSttLanguage: () => "auto",
        getSelfHostedApiKey: async () => "test-key",
        getWhisperPrompt: () => null,
        isDictionaryEcho: () => false,
        processTranscription: async (text) => text,
        isReasoningAvailable: async () => false,
        ...overrides,
      }),
  };
}

// Captures the prompt field each transcription request actually sent.
function capturePrompts(t) {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (endpoint, init) => {
    prompts.push(init.body.get("prompt"));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text: "transcribed text" }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return prompts;
}

// A ~100-term custom dictionary joined the way getCustomDictionaryPrompt does,
// mirroring the 1633-char report in #CUS-49 (1633 -> 899 at maxChars 900).
function buildLongDictionaryPrompt(count = 100) {
  const words = [];
  for (let i = 0; i < count; i++) {
    words.push(`SpecializedTerm${String(i).padStart(3, "0")}`);
  }
  return words.join(", ");
}

// Self-hosted servers take whatever model name the user typed, and most are
// Whisper-family under a name that never says so: the decoder reads ~223 prompt
// tokens, so the request is bounded at 900 characters on a whole entry.
test("a self-hosted server gets the Whisper-sized dictionary prompt", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-dictionary-prompt-cap-test-",
    settingsKey: "__dictionaryPromptCapSettings",
  });
  setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://stt.internal.example/v1",
    remoteTranscriptionModel: "Systran/faster-distil-large-v3",
  });

  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/wav" });
  const longPrompt = buildLongDictionaryPrompt();
  assert.ok(longPrompt.length > 1600, "fixture must exceed the 900-char cap");
  const prompts = capturePrompts(t);
  const manager = createManager({ getWhisperPrompt: () => longPrompt });

  const result = await manager.processWithSelfHosted(audioBlob, {});
  assert.equal(result.success, true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].length <= 900, `prompt must stay capped, got ${prompts[0].length}`);
  assert.ok(longPrompt.startsWith(prompts[0]), "truncation must keep the head of the list");
  assert.equal(longPrompt[prompts[0].length], ",", "truncation must end on a whole entry");
});

test("local whisper receives the dictionary whole, and echo checks see what it sent", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-dictionary-prompt-cap-local-test-",
    settingsKey: "__dictionaryPromptCapLocalSettings",
  });
  setSettings({ useLocalWhisper: true, localTranscriptionProvider: "whisper" });

  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  const longPrompt = buildLongDictionaryPrompt();
  const seen = [];
  window.electronAPI.transcribeLocalWhisper = async (_buf, options) => {
    seen.push(options.initialPrompt);
    return { success: true, text: "transcribed text" };
  };
  const manager = createManager({ getWhisperPrompt: () => longPrompt });

  const result = await manager.processWithLocalWhisper(audioBlob, "base", {});
  assert.equal(result.success, true);
  assert.equal(seen.length, 1);
  // A client-side character cut cannot give the head priority here: whisper.cpp
  // reads ~223 prompt tokens and keeps the TAIL of anything longer, so trimming
  // to 900 chars would only pick a different middle slice — and would leave the
  // echo recovery classifying against a string the decoder never saw.
  assert.equal(seen[0], longPrompt, "local whisper must receive the dictionary uncut");
});
