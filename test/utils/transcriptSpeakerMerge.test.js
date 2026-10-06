const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

const liveSegment = (id, speaker, text) => ({ id, source: "system", timestamp: 1, speaker, text });

// Naming a speaker mid-meeting labels whatever the live identifier had grouped under
// that id. The final diarization re-clusters; its result has to win, or names given
// against noisy live clusters contradict the final speakers for the rest of the note.
test("a speaker named during the meeting yields to the final diarization", async () => {
  const { nameTranscriptSpeaker, mergeTranscriptSegments, resolveSegmentSpeakerName } =
    await load();
  const existing = [
    nameTranscriptSpeaker(liveSegment("a", "speaker_0", "Thanks for having me."), {
      speakerName: "Christian",
      speakerIsPlaceholder: false,
    }),
  ];
  const diarized = [
    {
      id: "diarized-0",
      source: "system",
      timestamp: 1,
      text: "Thanks for having me.",
      speaker: "speaker_1",
      speakerName: "Curtis",
      speakerIsPlaceholder: false,
      speakerStatus: "confirmed",
    },
  ];

  const [merged] = mergeTranscriptSegments(existing, diarized);

  assert.equal(merged.speaker, "speaker_1");
  assert.equal(merged.speakerName, "Curtis");
  assert.equal(merged.speakerLocked, false);
  assert.equal(
    resolveSegmentSpeakerName(merged, { speaker_0: "Christian", speaker_1: "Curtis" }),
    "Curtis"
  );
});

test("a segment moved to an unnamed cluster drops its old cluster's name", async () => {
  const { nameTranscriptSpeaker, mergeTranscriptSegments } = await load();
  const existing = [
    nameTranscriptSpeaker(liveSegment("a", "speaker_0", "Yeah."), { speakerName: "Christian" }),
  ];
  const diarized = [
    { id: "d", source: "system", timestamp: 1, text: "Yeah.", speaker: "speaker_2" },
  ];

  const [merged] = mergeTranscriptSegments(existing, diarized);

  assert.equal(merged.speaker, "speaker_2");
  assert.equal(merged.speakerName, undefined);
});

test("a segment diarization keeps in its cluster keeps the cluster's name", async () => {
  const { nameTranscriptSpeaker, mergeTranscriptSegments } = await load();
  const existing = [
    nameTranscriptSpeaker(liveSegment("a", "speaker_0", "Yeah."), { speakerName: "Christian" }),
  ];
  const diarized = [
    { id: "d", source: "system", timestamp: 1, text: "Yeah.", speaker: "speaker_0" },
  ];

  const [merged] = mergeTranscriptSegments(existing, diarized);

  assert.equal(merged.speakerName, "Christian");
});

test("a per-segment correction still survives diarization moving the segment", async () => {
  const { lockTranscriptSpeaker, mergeTranscriptSegments, resolveSegmentSpeakerName } =
    await load();
  const existing = [
    lockTranscriptSpeaker(liveSegment("a", "speaker_0", "Yeah."), { speakerName: "Bob" }),
  ];
  const diarized = [
    {
      id: "d",
      source: "system",
      timestamp: 1,
      text: "Yeah.",
      speaker: "speaker_1",
      speakerName: "Alice",
    },
  ];

  const [merged] = mergeTranscriptSegments(existing, diarized);

  assert.equal(merged.speaker, "speaker_1");
  assert.equal(merged.speakerName, "Bob");
  assert.equal(resolveSegmentSpeakerName(merged, { speaker_1: "Alice" }), "Bob");
});

test("naming a speaker clears an older lock so the name can follow the cluster", async () => {
  const { lockTranscriptSpeaker, nameTranscriptSpeaker, isTranscriptSpeakerLocked } = await load();
  const locked = lockTranscriptSpeaker(liveSegment("a", "speaker_0", "Hi."), {
    speakerName: "Bob",
  });

  const named = nameTranscriptSpeaker(locked, { speakerName: "Alice" });

  assert.equal(isTranscriptSpeakerLocked(named), false);
  assert.equal(named.speakerStatus, "confirmed");
  assert.equal(named.speakerName, "Alice");
});
