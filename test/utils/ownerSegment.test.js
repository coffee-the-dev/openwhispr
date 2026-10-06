const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

const owners = ["You", "Steve"];
const mic = (speaker, extra = {}) => ({ source: "mic", speaker, text: "hi", ...extra });

test("a diarized mic cluster mapped to the owner is the owner's", async () => {
  const { isOwnerSegment } = await load();
  const mappings = { speaker_0: "Steve", speaker_1: "Dan" };
  assert.equal(isOwnerSegment(mic("speaker_0"), mappings, owners), true);
  assert.equal(isOwnerSegment(mic("speaker_1"), mappings, owners), false);
  assert.equal(isOwnerSegment(mic("speaker_0"), { speaker_0: "you" }, owners), true);
});

test("an unmapped diarized mic cluster is not assumed to be the owner", async () => {
  const { isOwnerSegment } = await load();
  assert.equal(isOwnerSegment(mic("speaker_0", { speakerName: "Dan" }), {}, owners), false);
  assert.equal(isOwnerSegment(mic("speaker_0", { speakerName: "steve" }), {}, owners), true);
});

test("undiarized mic and the you sentinel stay the owner's", async () => {
  const { isOwnerSegment } = await load();
  assert.equal(isOwnerSegment(mic(undefined), {}, owners), true);
  assert.equal(isOwnerSegment({ source: "system", speaker: "you", text: "hi" }, {}, owners), true);
  assert.equal(
    isOwnerSegment({ source: "system", speaker: "speaker_0", text: "hi" }, {}, owners),
    false
  );
});

test("a blank owner name never matches", async () => {
  const { isOwnerSegment } = await load();
  assert.equal(isOwnerSegment(mic("speaker_0"), { speaker_0: "Dan" }, ["You", ""]), false);
});
