const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  archiveMeetingAudio,
  listMeetingAudioForNote,
  deleteMeetingAudioForNote,
  deleteExpiredMeetingAudio,
  deleteAllMeetingAudio,
  getMeetingAudioUsage,
} = require("../../src/helpers/meetingAudioArchive");
Module._load = originalLoad;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-audio-test-"));
const copyConvert = async (input, output) => fs.promises.copyFile(input, output);

test("archives each track under the note's name and source", async () => {
  const dir = tempDir();
  const wav = path.join(dir, "input.wav");
  fs.writeFileSync(wav, "RIFF");
  const startedAt = Date.UTC(2026, 9, 6, 12, 31, 38);

  const main = await archiveMeetingAudio(wav, {
    noteId: 25,
    startedAt,
    track: "mic",
    dir,
    convert: copyConvert,
  });
  const alt = await archiveMeetingAudio(wav, {
    noteId: 25,
    startedAt,
    track: "system-alt",
    dir,
    convert: copyConvert,
  });

  assert.equal(path.basename(main), "note-25-2026-10-06T12-31-38-000Z-mic.mp3");
  assert.equal(path.basename(alt), "note-25-2026-10-06T12-31-38-000Z-system-alt.mp3");
  assert.equal(fs.readFileSync(main, "utf8"), "RIFF");
});

test("deleting a note removes only that note's audio", async () => {
  const dir = tempDir();
  for (const name of ["note-1-a.mp3", "note-1-b.mp3", "note-12-a.mp3", "meeting-a.mp3"]) {
    fs.writeFileSync(path.join(dir, name), "");
  }

  assert.equal(await deleteMeetingAudioForNote(1, { dir }), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["meeting-a.mp3", "note-12-a.mp3"]);
});

test("deleting audio for a note without an archive folder is a no-op", async () => {
  const missing = path.join(os.tmpdir(), `ow-meeting-audio-missing-${process.pid}`);
  assert.equal(await deleteMeetingAudioForNote(3, { dir: missing }), 0);
});

test("lists a note's sessions oldest first with their start times", async () => {
  const dir = tempDir();
  for (const name of [
    "note-7-2026-10-28T21-19-36-500Z.mp3",
    "note-7-2026-10-28T20-00-00-000Z.mp3",
    "note-70-2026-10-28T20-00-00-000Z.mp3",
  ]) {
    fs.writeFileSync(path.join(dir, name), "");
  }

  const sessions = await listMeetingAudioForNote(7, { dir });
  assert.deepEqual(
    sessions.map(({ filePath, startedAt }) => [path.basename(filePath), startedAt]),
    [
      ["note-7-2026-10-28T20-00-00-000Z.mp3", Date.UTC(2026, 9, 28, 20, 0, 0)],
      ["note-7-2026-10-28T21-19-36-500Z.mp3", Date.UTC(2026, 9, 28, 21, 19, 36, 500)],
    ]
  );
});

test("a session's two tracks list as one session, main track first", async () => {
  const dir = tempDir();
  for (const name of [
    "note-9-2026-10-29T14-09-06-860Z-system-alt.mp3",
    "note-9-2026-10-29T14-09-06-860Z-mic.mp3",
    "note-9-2026-10-29T15-00-00-000Z-mic-alt.mp3",
  ]) {
    fs.writeFileSync(path.join(dir, name), "");
  }

  const sessions = await listMeetingAudioForNote(9, { dir });
  const at = (file) => file && path.basename(file);
  assert.deepEqual(
    sessions.map((s) => [at(s.filePath), s.source, at(s.alternate?.filePath), s.startedAt]),
    [
      [
        "note-9-2026-10-29T14-09-06-860Z-mic.mp3",
        "mic",
        "note-9-2026-10-29T14-09-06-860Z-system-alt.mp3",
        Date.UTC(2026, 9, 29, 14, 9, 6, 860),
      ],
      // A session whose main track was never written falls back to the other.
      ["note-9-2026-10-29T15-00-00-000Z-mic-alt.mp3", "mic", undefined, Date.UTC(2026, 9, 29, 15)],
    ]
  );
  assert.equal(await deleteMeetingAudioForNote(9, { dir }), 3);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("expiry, usage and clear-all cover every kept meeting file", async () => {
  const dir = tempDir();
  const now = Date.now();
  const old = path.join(dir, "note-1-a.mp3");
  const fresh = path.join(dir, "note-2-b.mp3");
  fs.writeFileSync(old, "12345");
  fs.writeFileSync(fresh, "123");
  const tenDaysAgo = (now - 10 * 86400000) / 1000;
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);

  assert.deepEqual(await getMeetingAudioUsage({ dir }), { fileCount: 2, totalBytes: 8 });
  assert.equal(await deleteExpiredMeetingAudio(7, { dir, now }), 1);
  assert.deepEqual(fs.readdirSync(dir), ["note-2-b.mp3"]);
  assert.equal(await deleteAllMeetingAudio({ dir }), 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});
