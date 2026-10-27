process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFileStem,
  buildNoteMarkdown,
  buildTranscriptMarkdown,
  formatCalendarEvent,
  parseFrontmatter,
  sanitizeFileTitle,
  sanitizeTag,
  stripLeadingTitleHeading,
} = require("../../src/helpers/noteExportFormat");

const meeting = {
  id: 7,
  client_note_id: "3f2a",
  title: "Planning: Q3",
  note_type: "meeting",
  content: "my raw notes",
  enhanced_content: "# Planning: Q3\n\n## Summary\nWe agreed.",
  created_at: "2026-09-25 18:30:35",
  updated_at: "2026-09-25 19:04:28",
  audio_duration_seconds: 1830,
  participants: JSON.stringify([
    { displayName: "Me", self: true },
    { displayName: "Ada Lovelace", email: "ada@example.com" },
    { email: "guest@example.com" },
  ]),
  transcript: JSON.stringify([
    { speaker: "speaker_0", timestamp: 0, text: "Hi." },
    { speaker: "speaker_1", timestamp: 5, text: "Hello." },
  ]),
};

const ctx = {
  folderName: "Meetings",
  baseTag: "openwhispr",
  speakerMappings: { speaker_1: "Grace Hopper", speaker_0: "ada lovelace" },
  calendarEvent: {
    summary: "Q3 planning",
    start_time: "2026-09-25T18:30:00Z",
    end_time: "2026-09-25T19:00:00Z",
  },
};

test("file titles drop characters that break paths or wikilinks", () => {
  assert.equal(sanitizeFileTitle("Steve / Pragya"), "Steve Pragya");
  assert.equal(sanitizeFileTitle('a[b]#c^d|e:f\\g*?"<>'), "a b c d e f g");
  assert.equal(sanitizeFileTitle("..hidden. "), "hidden");
  assert.equal(sanitizeFileTitle("line\nbreak"), "line break");
  assert.equal(sanitizeFileTitle("   "), "Untitled");
  assert.equal(Array.from(sanitizeFileTitle("x".repeat(200))).length, 80);
  assert.equal(buildFileStem(meeting), "2026-09-25 Planning Q3");
  assert.equal(buildFileStem(meeting, "ow7"), "2026-09-25 Planning Q3 (ow7)");
});

test("tags are sanitized to what Obsidian accepts", () => {
  assert.equal(sanitizeTag("#Open Whispr"), "Open-Whispr");
  assert.equal(sanitizeTag("work/meetings"), "work/meetings");
  assert.equal(sanitizeTag("2026"), null);
  assert.equal(sanitizeTag("!!"), null);
});

test("the note file carries full frontmatter, summary first, raw notes after", () => {
  const md = buildNoteMarkdown(meeting, ctx, "2026-09-25 Planning Q3");
  assert.equal(
    md.split("\n---\n")[0] + "\n---",
    [
      "---",
      "openwhispr_id: 7",
      'openwhispr_uid: "3f2a"',
      "openwhispr_updated: 2026-09-25T19:04:28Z",
      'title: "Planning: Q3"',
      "type: meeting",
      "date: 2026-09-25",
      "created: 2026-09-25T18:30:35",
      "updated: 2026-09-25T19:04:28",
      "folder: Meetings",
      'duration: "30:30"',
      "participants:",
      "  - Ada Lovelace",
      "  - guest@example.com",
      "  - Grace Hopper",
      "calendar_event: Q3 planning (2026-09-25 18:30–19:00)",
      "ai_summary: true",
      "tags:",
      "  - openwhispr",
      "  - meeting",
      'transcript: "[[2026-09-25 Planning Q3 (transcript)]]"',
      "---",
    ].join("\n")
  );
  const body = md.slice(md.indexOf("\n---\n") + 5);
  assert.equal(
    body,
    [
      "",
      "Related: [[2026-09-25 Planning Q3 (transcript)|Transcript]]",
      "",
      "## Summary\nWe agreed.",
      "",
      "<!-- openwhispr:notes -->",
      "## Notes",
      "",
      "my raw notes",
      "",
      "Source: [[2026-09-25 Planning Q3 (transcript)|Transcript]]",
      "",
    ].join("\n")
  );
  assert.doesNotMatch(md, /^# /m);
});

test("raw notes stand alone without a summary, and are not repeated when equal", () => {
  const plain = buildNoteMarkdown(
    { ...meeting, enhanced_content: null, transcript: null, note_type: "personal" },
    ctx,
    "s"
  );
  assert.match(plain, /\ntype: note\n/);
  assert.match(plain, /---\n\nmy raw notes\n$/);
  assert.doesNotMatch(plain, /Related:|transcript:/);

  const same = buildNoteMarkdown({ ...meeting, enhanced_content: "my raw notes" }, ctx, "s");
  assert.doesNotMatch(same, /## Notes/);
});

test("the transcript file links back to the note and has no duplicate H1", () => {
  const md = buildTranscriptMarkdown(meeting, ctx, "2026-09-25 Planning Q3");
  const fields = parseFrontmatter(md);
  assert.equal(fields.openwhispr_id, "7");
  assert.equal(fields.summary, "[[2026-09-25 Planning Q3]]");
  assert.match(md, /\n {2}- transcript\n/);
  assert.match(md, /\nRelated: \[\[2026-09-25 Planning Q3\|Planning: Q3\]\]\n/);
  assert.match(md, /\*\*ada lovelace\*\* `00:00:00`\nHi\.\n/);
  assert.match(md, /\*\*Grace Hopper\*\* `00:00:05`\nHello\.\n/);
  assert.doesNotMatch(md, /^# /m);
});

test("frontmatter values round-trip through the parser", () => {
  const tricky = { ...meeting, title: 'He said "yes"\tthen: no' };
  const fields = parseFrontmatter(buildNoteMarkdown(tricky, ctx, "s"));
  assert.equal(fields.title, tricky.title);
  assert.equal(parseFrontmatter("\uFEFF---\r\nid: 3\r\n---\r\nbody").id, "3");
  assert.equal(parseFrontmatter("no frontmatter"), null);
});

test("only a leading H1 equal to the title is stripped", () => {
  assert.equal(stripLeadingTitleHeading("# Title\n\nBody", "title"), "Body");
  assert.equal(stripLeadingTitleHeading("# Other\n\nBody", "Title"), "# Other\n\nBody");
  assert.equal(stripLeadingTitleHeading("Body\n# Title", "Title"), "Body\n# Title");
});

test("calendar events format as a title with a local time range", () => {
  assert.equal(formatCalendarEvent(null), null);
  assert.equal(
    formatCalendarEvent({ summary: "Offsite", start_time: "2026-09-25T00:00:00Z", is_all_day: 1 }),
    "Offsite (2026-09-25)"
  );
});

test("a stray absolute timestamp does not inflate the transcript duration", () => {
  const md = buildNoteMarkdown(
    {
      ...meeting,
      audio_duration_seconds: null,
      transcript: JSON.stringify([
        { speaker: "you", timestamp: 19.8, text: "Hi." },
        { speaker: "you", timestamp: 1790362816050, text: "Stray." },
        { speaker: "you", timestamp: 1810.2, text: "Bye." },
      ]),
    },
    ctx,
    "s"
  );
  assert.match(md, /\nduration: "30:10"\n/);
});
