const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The PCM tap's WAV is what the local engine decodes; the WebM keeps being the
// recording of record for history and cloud fallbacks, so it must stay untouched.

async function loadManager(t) {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-raw-wav-test-",
    settingsKey: "__rawWavSettings",
  });
  setSettings({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "orukeet-v0.1.0",
    preferredLanguage: "en",
    customDictionary: [],
  });
  const sent = [];
  window.electronAPI.transcribeLocalParakeet = async (buffer) => {
    sent.push(Array.from(new Uint8Array(buffer)));
    return { success: true, text: "hi" };
  };
  window.electronAPI.transcribeLocalWhisper = window.electronAPI.transcribeLocalParakeet;
  const manager = createManager({ processTranscription: async (text) => text });
  return { manager, sent };
}

const webm = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });

test("the PCM tap's WAV goes to Parakeet instead of the WebM", async (t) => {
  const { manager, sent } = await loadManager(t);

  const result = await manager.processWithLocalParakeet(webm(), "orukeet-v0.1.0", {
    rawWav: wav(),
  });

  assert.equal(result.text, "hi");
  assert.deepEqual(sent, [[82, 73, 70, 70]]);
});

test("the PCM tap's WAV goes to whisper.cpp instead of the WebM", async (t) => {
  const { manager, sent } = await loadManager(t);

  await manager.processWithLocalWhisper(webm(), "base", { rawWav: wav() });

  assert.deepEqual(sent, [[82, 73, 70, 70]]);
});

test("without a tap the WebM is sent as before", async (t) => {
  const { manager, sent } = await loadManager(t);

  await manager.processWithLocalParakeet(webm(), "orukeet-v0.1.0", {});

  assert.deepEqual(sent, [[1, 2, 3]]);
});
