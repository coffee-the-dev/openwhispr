const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

// The owner's configured name (Settings > General > Your name) marks their voice
// the same way "You" does.
const YOU = "You";
const OWNER = "Steve";
const mic = (speaker, extra = {}) => ({ source: "mic", speaker, text: "hi", ...extra });

test("a diarized mic cluster mapped to the owner's name sits on the owner's side", async () => {
  const { isSelfSideSegment } = await load();
  const mappings = { speaker_0: "Steve", speaker_1: "Dan" };
  assert.equal(isSelfSideSegment(mic("speaker_0"), mappings, YOU, OWNER), true);
  assert.equal(isSelfSideSegment(mic("speaker_1"), mappings, YOU, OWNER), false);
  assert.equal(isSelfSideSegment(mic("speaker_0"), { speaker_0: "you" }, YOU, OWNER), true);
});

test("a segment named after the owner is theirs, case-insensitively", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(isSelfSideSegment(mic("speaker_0", { speakerName: "Dan" }), {}, YOU, OWNER), false);
  assert.equal(isSelfSideSegment(mic("speaker_0", { speakerName: "steve" }), {}, YOU, OWNER), true);
});

test("a blank owner name never matches", async () => {
  const { isYouSpeakerName } = await load();
  assert.equal(isYouSpeakerName("", YOU, ""), false);
  assert.equal(isYouSpeakerName("Dan", YOU, "  "), false);
  assert.equal(isYouSpeakerName(" Steve ", YOU, "steve"), true);
});
