process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNoteMarkdown,
  buildTranscriptMarkdown,
} = require("../../src/helpers/noteExportFormat");
const {
  buildLabels,
  changedColumns,
  parseExportedNote,
} = require("../../src/helpers/noteImportFormat");

const meeting = {
  id: 7,
  client_note_id: "3f2a",
  title: "Planning: Q3",
  note_type: "meeting",
  // A summary with its own "## Notes" section must not swallow the raw notes.
  content: "my raw notes\n\n## Notes\n\n- typed",
  enhanced_content: "## Summary\nWe agreed.\n\n## Notes\n- from the model",
  created_at: "2026-09-25 18:30:35",
  updated_at: "2026-09-25 19:04:28",
  audio_duration_seconds: 1830,
  transcript: JSON.stringify([
    { speaker: "you", source: "mic", timestamp: 0, text: "Hi." },
    { speaker: "speaker_1", source: "system", timestamp: 5, text: "Hello." },
    { speaker: "speaker_2", source: "system", timestamp: 9, text: "Morning." },
  ]),
};
const ctx = { folderName: "Work", speakerMappings: { speaker_1: "Grace Hopper" } };
const exported = (note) => [
  buildNoteMarkdown(note, ctx, "stem"),
  buildTranscriptMarkdown(note, ctx, "stem"),
];

test("an exported note parses back into the fields it was written from", () => {
  const parsed = parseExportedNote(...exported(meeting));
  assert.equal(parsed.clientNoteId, "3f2a");
  assert.equal(parsed.title, "Planning: Q3");
  assert.equal(parsed.noteType, "meeting");
  assert.equal(parsed.folderName, "Work");
  assert.equal(parsed.createdAt, meeting.created_at);
  assert.equal(parsed.updatedAt, meeting.updated_at);
  assert.equal(parsed.enhancedContent, meeting.enhanced_content);
  assert.equal(parsed.content, meeting.content);
  assert.equal(parsed.audioDurationSeconds, 1830);
  assert.deepEqual(JSON.parse(parsed.transcript), [
    { text: "Hi.", timestamp: 0, source: "mic", speaker: "you" },
    {
      text: "Hello.",
      timestamp: 5,
      source: "system",
      speakerName: "Grace Hopper",
      speakerLocked: true,
      speakerLockSource: "user",
    },
    { text: "Morning.", timestamp: 9, source: "system", speaker: "speaker_2" },
  ]);
  // The named speaker is in the transcript, so it isn't also a participant.
  assert.equal(parsed.participants, null);
});

test("the exact UTC update time wins over the local-time property", () => {
  const [note] = exported(meeting);
  const shifted = note.replace("\nupdated: 2026-09-25T19:04:28", "\nupdated: 2026-09-25T15:04:28");
  assert.equal(parseExportedNote(shifted, null).updatedAt, "2026-09-25 19:04:28");
});

test("a note without a summary keeps all of its body as raw notes", () => {
  const plain = { ...meeting, enhanced_content: null, transcript: null };
  const parsed = parseExportedNote(buildNoteMarkdown(plain, ctx, "stem"), null);
  assert.equal(parsed.content, plain.content);
  assert.equal(parsed.enhancedContent, null);
  assert.equal(parsed.transcript, null);
});

test("files exported before the sync fields existed still split summary and notes", () => {
  const legacy = [
    "---",
    "openwhispr_id: 50",
    'openwhispr_uid: "3ee9"',
    "title: Nick / Steve",
    "type: note",
    "created: 2026-10-23T10:01:46",
    "updated: 2026-10-23T10:42:30",
    "folder: isolved",
    "participants:",
    "  - nholcomb@example.com",
    'transcript: "[[s (transcript)]]"',
    "---",
    "",
    "Related: [[s (transcript)|Transcript]]",
    "",
    "## Summary\n- Agreed",
    "",
    "## Notes",
    "",
    "typed",
    "",
    "Source: [[s (transcript)|Transcript]]",
    "",
  ].join("\n");
  const transcript = [
    "---",
    "openwhispr_id: 50",
    'openwhispr_uid: "3ee9"',
    'summary: "[[s]]"',
    "---",
    "",
    "Related: [[s|Nick / Steve]]",
    "",
    "**Vous** `00:00:04`",
    "Bonjour.",
    "",
    "**Intervenant 3** `497990033:53:18`",
    "Salut.",
    "",
  ].join("\n");
  const french = (key, options) =>
    ({
      "transcript.speaker.you": "Vous",
      "notes.speaker.label": `Intervenant ${options?.n}`,
    })[key] ?? key;

  const parsed = parseExportedNote(legacy, transcript, buildLabels(french));
  assert.equal(parsed.noteType, "personal");
  assert.equal(parsed.updatedAt, "2026-10-23 10:42:30");
  assert.equal(parsed.enhancedContent, "## Summary\n- Agreed");
  assert.equal(parsed.content, "typed");
  assert.deepEqual(JSON.parse(parsed.participants), [{ displayName: "nholcomb@example.com" }]);
  // An absolute epoch printed as an offset falls back to the previous time.
  assert.deepEqual(JSON.parse(parsed.transcript), [
    { text: "Bonjour.", timestamp: 4, source: "mic", speaker: "you" },
    { text: "Salut.", timestamp: 4, source: "system", speaker: "speaker_2" },
  ]);
});

test("only fields the export renders differently count as changes", () => {
  const current = parseExportedNote(...exported(meeting));
  const renamed = parseExportedNote(...exported({ ...meeting, title: "Planning: Q4" }));
  assert.deepEqual(changedColumns(current, current), {});
  assert.deepEqual(changedColumns(current, renamed), { title: "Planning: Q4" });
  assert.deepEqual(changedColumns(current, { ...current, audioDurationSeconds: null }), {});
});

test("files that are not OpenWhispr note exports are ignored", () => {
  const [, transcript] = exported(meeting);
  assert.equal(parseExportedNote("# My own note\n", null), null);
  assert.equal(parseExportedNote("---\ntitle: Mine\n---\n\nbody\n", null), null);
  assert.equal(parseExportedNote(transcript, null), null);
});
