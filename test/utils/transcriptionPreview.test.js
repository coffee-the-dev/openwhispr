const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptionPreview.ts");

test("live transcription preview remains available for local transcription", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("local"), true);
});

test("batch-only self-hosted transcription does not advertise live preview", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("self-hosted"), false);
});

test("assistant-routed recordings never show the dictation preview", async () => {
  const { shouldDisplayDictationPreview } = await load();

  assert.equal(shouldDisplayDictationPreview(true, false), true);
  assert.equal(shouldDisplayDictationPreview(true, true), false);
  assert.equal(shouldDisplayDictationPreview(false, false), false);
});
